import type {
  BuildIssue,
  BuildMutationResult,
  BuildNode,
  BuildValidationResult,
  FactoryPresetNode,
  FlatBuildNode,
  WeaponBuild,
  WeaponCatalog,
  WeaponCatalogItem,
  WeaponConflictRule,
  WeaponPartItem,
  WeaponSlotRule,
  WeaponStats,
} from "../types/weapon-modding";

const itemIndexes = new WeakMap<WeaponCatalog, Map<string, WeaponCatalogItem>>();
const CENTER_OF_IMPACT_TO_MOA = (180 / Math.PI) * 60 / 100;

export function centerOfImpactToMoa(centerOfImpact: number): number {
  return Math.max(0, centerOfImpact) * CENTER_OF_IMPACT_TO_MOA;
}

function itemIndex(catalog: WeaponCatalog): Map<string, WeaponCatalogItem> {
  const existing = itemIndexes.get(catalog);
  if (existing) return existing;
  const created = new Map(catalog.items.map((item) => [item.id, item]));
  itemIndexes.set(catalog, created);
  return created;
}

function hasCategory(
  item: WeaponCatalogItem,
  categories: readonly string[] | undefined,
): boolean {
  return Boolean(categories?.some((category) => item.categories.includes(category)));
}

function slotRuleIssues(
  slot: WeaponSlotRule,
  item: WeaponCatalogItem,
  parentInstanceId: string,
): BuildIssue[] {
  const context = {
    itemId: item.id,
    parentInstanceId,
    slotId: slot.id,
  };

  if (
    slot.excludedItemIds?.includes(item.id) ||
    hasCategory(item, slot.excludedCategories)
  ) {
    return [
      {
        code: "ITEM_EXCLUDED",
        message: `${item.id} is excluded from slot ${slot.id}.`,
        ...context,
      },
    ];
  }

  const hasAllowFilter = Boolean(
    slot.allowedItemIds?.length || slot.allowedCategories?.length,
  );
  const isAllowed =
    item.kind === "part" &&
    hasAllowFilter &&
    (Boolean(slot.allowedItemIds?.includes(item.id)) ||
      hasCategory(item, slot.allowedCategories));

  return isAllowed
    ? []
    : [
        {
          code: "ITEM_NOT_ALLOWED",
          message: `${item.id} is not allowed in slot ${slot.id}.`,
          ...context,
        },
      ];
}

function flattenNode(
  node: BuildNode,
  parentInstanceId: string | null,
  depth: number,
  result: FlatBuildNode[],
): void {
  result.push({
    instanceId: node.instanceId,
    itemId: node.itemId,
    parentInstanceId,
    slotId: node.slotId ?? null,
    depth,
  });
  for (const child of node.children) {
    flattenNode(child, node.instanceId, depth + 1, result);
  }
}

export function flattenBuildTree(root: BuildNode): FlatBuildNode[] {
  const result: FlatBuildNode[] = [];
  flattenNode(root, null, 0, result);
  return result;
}

function findNode(root: BuildNode, instanceId: string): BuildNode | undefined {
  if (root.instanceId === instanceId) return root;
  for (const child of root.children) {
    const match = findNode(child, instanceId);
    if (match) return match;
  }
  return undefined;
}

function conflictKinds(
  rule: WeaponConflictRule | undefined,
  targetItem: WeaponCatalogItem,
  targetSlotId: string | null,
): Array<"ITEM_CONFLICT" | "SLOT_CONFLICT"> {
  const result: Array<"ITEM_CONFLICT" | "SLOT_CONFLICT"> = [];
  if (
    rule?.itemIds?.includes(targetItem.id) ||
    hasCategory(targetItem, rule?.categories)
  ) {
    result.push("ITEM_CONFLICT");
  }
  if (targetSlotId && rule?.slotIds?.includes(targetSlotId)) {
    result.push("SLOT_CONFLICT");
  }
  return result;
}

function pairConflictIssues(
  source: FlatBuildNode,
  sourceItem: WeaponCatalogItem,
  target: FlatBuildNode,
  targetItem: WeaponCatalogItem,
): BuildIssue[] {
  const forward = conflictKinds(sourceItem.conflicts, targetItem, target.slotId);
  const reverse = conflictKinds(targetItem.conflicts, sourceItem, source.slotId);
  const codes = [...new Set([...forward, ...reverse])];

  return codes.map((code) => ({
    code,
    message: `${sourceItem.id} conflicts with ${targetItem.id}.`,
    instanceId: source.instanceId,
    itemId: sourceItem.id,
    slotId: source.slotId ?? undefined,
    relatedInstanceId: target.instanceId,
    relatedItemId: targetItem.id,
  }));
}

function withoutSlot(build: WeaponBuild, parentInstanceId: string, slotId: string): WeaponBuild {
  const remove = (node: BuildNode): BuildNode => {
    if (node.instanceId === parentInstanceId) {
      return {
        ...node,
        children: node.children.filter((child) => child.slotId !== slotId),
      };
    }
    return { ...node, children: node.children.map(remove) };
  };
  return { ...build, root: remove(build.root) };
}

export function evaluateCandidateCompatibility(
  catalog: WeaponCatalog,
  build: WeaponBuild,
  parentInstanceId: string,
  slotId: string,
  candidateItemId: string,
): BuildValidationResult {
  const index = itemIndex(catalog);
  const parentNode = findNode(build.root, parentInstanceId);
  if (!parentNode) {
    const issues: BuildIssue[] = [
      {
        code: "UNKNOWN_PARENT",
        message: `Build parent ${parentInstanceId} does not exist.`,
        parentInstanceId,
        slotId,
      },
    ];
    return { isValid: false, issues };
  }

  const parentItem = index.get(parentNode.itemId);
  const slot = parentItem?.slots?.find((candidate) => candidate.id === slotId);
  if (!slot) {
    const issues: BuildIssue[] = [
      {
        code: "UNKNOWN_SLOT",
        message: `Slot ${slotId} does not exist on ${parentNode.itemId}.`,
        parentInstanceId,
        itemId: parentNode.itemId,
        slotId,
      },
    ];
    return { isValid: false, issues };
  }

  const candidate = index.get(candidateItemId);
  if (!candidate) {
    const issues: BuildIssue[] = [
      {
        code: "UNKNOWN_ITEM",
        message: `Catalog item ${candidateItemId} does not exist.`,
        itemId: candidateItemId,
        parentInstanceId,
        slotId,
      },
    ];
    return { isValid: false, issues };
  }

  const issues = slotRuleIssues(slot, candidate, parentInstanceId);
  const remaining = withoutSlot(build, parentInstanceId, slotId);
  const candidateNode: FlatBuildNode = {
    instanceId: `${parentInstanceId}/${slotId}`,
    itemId: candidate.id,
    parentInstanceId,
    slotId,
    depth: 0,
  };

  for (const installedNode of flattenBuildTree(remaining.root)) {
    const installedItem = index.get(installedNode.itemId);
    if (!installedItem) continue;
    issues.push(
      ...pairConflictIssues(candidateNode, candidate, installedNode, installedItem),
    );
  }

  return { isValid: issues.length === 0, issues };
}

export function isCompatibleCandidate(
  catalog: WeaponCatalog,
  build: WeaponBuild,
  parentInstanceId: string,
  slotId: string,
  candidateItemId: string,
): boolean {
  return evaluateCandidateCompatibility(
    catalog,
    build,
    parentInstanceId,
    slotId,
    candidateItemId,
  ).isValid;
}

export function getCompatibleCandidates(
  catalog: WeaponCatalog,
  build: WeaponBuild,
  parentInstanceId: string,
  slotId: string,
): WeaponPartItem[] {
  return catalog.items.filter(
    (item): item is WeaponPartItem =>
      item.kind === "part" &&
      isCompatibleCandidate(catalog, build, parentInstanceId, slotId, item.id),
  );
}

function factoryNode(
  index: ReadonlyMap<string, WeaponCatalogItem>,
  item: WeaponCatalogItem,
  instanceId: string,
  slotId: string | undefined,
  ancestors: ReadonlySet<string>,
  factoryPartsByParent: Readonly<Record<string, string[]>> | undefined,
): BuildNode {
  if (ancestors.has(item.id)) {
    throw new Error(`Factory part cycle detected at ${item.id}.`);
  }
  const nextAncestors = new Set(ancestors).add(item.id);
  const children: BuildNode[] = [];
  const slots = item.slots ?? [];
  const factoryPartIds = factoryPartsByParent?.[item.id] ?? item.factoryPartIds ?? [];
  const factoryParts = factoryPartIds.map((factoryPartId) => {
    const factoryPart = index.get(factoryPartId);
    if (!factoryPart || factoryPart.kind !== "part") {
      throw new Error(`Factory part ${factoryPartId} does not exist.`);
    }
    return factoryPart;
  });
  const candidates = factoryParts.map((factoryPart) => slots.flatMap((slot, slotIndex) =>
    slotRuleIssues(slot, factoryPart, instanceId).length === 0 ? [slotIndex] : [],
  ));
  const partOrder = factoryParts.map((_, partIndex) => partIndex).sort((left, right) =>
    candidates[left].length - candidates[right].length,
  );
  const slotByPart = new Map<number, number>();
  const occupiedSlots = new Set<number>();

  const assignSlots = (orderIndex: number): boolean => {
    if (orderIndex === partOrder.length) return true;
    const partIndex = partOrder[orderIndex];
    for (const slotIndex of candidates[partIndex]) {
      if (occupiedSlots.has(slotIndex)) continue;
      occupiedSlots.add(slotIndex);
      slotByPart.set(partIndex, slotIndex);
      if (assignSlots(orderIndex + 1)) return true;
      slotByPart.delete(partIndex);
      occupiedSlots.delete(slotIndex);
    }
    return false;
  };

  if (!assignSlots(0)) {
    const unplaceable = factoryParts.find((_, partIndex) => !candidates[partIndex].length);
    throw new Error(
      `Factory part ${unplaceable?.id ?? factoryParts[0]?.id ?? "unknown"} cannot be placed on ${item.id}.`,
    );
  }

  for (const [partIndex, factoryPart] of factoryParts.entries()) {
    const factorySlot = slots[slotByPart.get(partIndex) ?? -1];
    children.push(
      factoryNode(
        index,
        factoryPart,
        `${instanceId}/${factorySlot.id}`,
        factorySlot.id,
        nextAncestors,
        factoryPartsByParent,
      ),
    );
  }

  return { instanceId, itemId: item.id, slotId, children };
}

function factoryPresetNodes(
  index: ReadonlyMap<string, WeaponCatalogItem>,
  parentItem: WeaponCatalogItem,
  parentInstanceId: string,
  templates: readonly FactoryPresetNode[],
  ancestors: ReadonlySet<string>,
): BuildNode[] {
  const occupiedSlots = new Set<string>();
  return templates.map((template) => {
    if (occupiedSlots.has(template.slotId)) {
      throw new Error(`Factory preset uses slot ${template.slotId} more than once on ${parentItem.id}.`);
    }
    occupiedSlots.add(template.slotId);
    const slot = parentItem.slots?.find((candidate) => candidate.id === template.slotId);
    const part = index.get(template.itemId);
    if (!slot || !part || part.kind !== "part" ||
        slotRuleIssues(slot, part, parentInstanceId).length) {
      throw new Error(`Factory part ${template.itemId} cannot use slot ${template.slotId} on ${parentItem.id}.`);
    }
    if (ancestors.has(part.id)) {
      throw new Error(`Factory part cycle detected at ${part.id}.`);
    }
    const instanceId = `${parentInstanceId}/${template.slotId}`;
    const nextAncestors = new Set(ancestors).add(part.id);
    return {
      instanceId,
      itemId: part.id,
      slotId: slot.id,
      children: factoryPresetNodes(
        index,
        part,
        instanceId,
        template.children,
        nextAncestors,
      ),
    };
  });
}

export function createFactoryBuild(
  catalog: WeaponCatalog,
  weaponId: string,
): WeaponBuild {
  const index = itemIndex(catalog);
  const weapon = index.get(weaponId);
  if (!catalog.weaponIds.includes(weaponId) || weapon?.kind !== "weapon") {
    throw new Error(`Catalog weapon ${weaponId} does not exist.`);
  }

  const rootInstanceId = `root:${weaponId}`;
  return {
    schemaVersion: 1,
    catalogDataVersion: catalog.dataVersion,
    weaponId,
    root: weapon.factoryPresetBuild ? {
      instanceId: rootInstanceId,
      itemId: weapon.id,
      children: factoryPresetNodes(
        index,
        weapon,
        rootInstanceId,
        weapon.factoryPresetBuild,
        new Set([weapon.id]),
      ),
    } : factoryNode(
      index,
      weapon,
      rootInstanceId,
      undefined,
      new Set(),
      weapon.factoryPartsByParent,
    ),
  };
}

export function replaceBuildSlot(
  catalog: WeaponCatalog,
  build: WeaponBuild,
  parentInstanceId: string,
  slotId: string,
  candidateItemId: string,
): BuildMutationResult {
  const parent = findNode(build.root, parentInstanceId);
  const existing = parent?.children.find((child) => child.slotId === slotId);
  if (existing?.itemId === candidateItemId) {
    return { ok: true, build, removedNodes: [] };
  }

  const compatibility = evaluateCandidateCompatibility(
    catalog,
    build,
    parentInstanceId,
    slotId,
    candidateItemId,
  );
  if (!compatibility.isValid) {
    return { ok: false, build, issues: compatibility.issues };
  }

  const removedNodes: FlatBuildNode[] = [];
  const replace = (node: BuildNode, depth: number): BuildNode => {
    if (node.instanceId === parentInstanceId) {
      const previous = node.children.find((child) => child.slotId === slotId);
      if (previous) flattenNode(previous, node.instanceId, depth + 1, removedNodes);
      const replacement: BuildNode = {
        instanceId: previous?.instanceId ?? `${node.instanceId}/${slotId}`,
        itemId: candidateItemId,
        slotId,
        children: [],
      };
      return {
        ...node,
        children: previous
          ? node.children.map((child) =>
              child.slotId === slotId ? replacement : child,
            )
          : [...node.children, replacement],
      };
    }
    return {
      ...node,
      children: node.children.map((child) => replace(child, depth + 1)),
    };
  };

  return {
    ok: true,
    build: { ...build, root: replace(build.root, 0) },
    removedNodes,
  };
}

export function removeBuildSlot(
  build: WeaponBuild,
  parentInstanceId: string,
  slotId: string,
): BuildMutationResult {
  if (!findNode(build.root, parentInstanceId)) {
    return {
      ok: false,
      build,
      issues: [
        {
          code: "UNKNOWN_PARENT",
          message: `Build parent ${parentInstanceId} does not exist.`,
          parentInstanceId,
          slotId,
        },
      ],
    };
  }

  const removedNodes: FlatBuildNode[] = [];
  const remove = (node: BuildNode, depth: number): BuildNode => {
    if (node.instanceId === parentInstanceId) {
      const previous = node.children.find((child) => child.slotId === slotId);
      if (previous) flattenNode(previous, node.instanceId, depth + 1, removedNodes);
      return {
        ...node,
        children: node.children.filter((child) => child.slotId !== slotId),
      };
    }
    return {
      ...node,
      children: node.children.map((child) => remove(child, depth + 1)),
    };
  };

  if (!findNode(build.root, parentInstanceId)?.children.some(
    (child) => child.slotId === slotId,
  )) {
    return { ok: true, build, removedNodes };
  }

  return {
    ok: true,
    build: { ...build, root: remove(build.root, 0) },
    removedNodes,
  };
}

export function validateWeaponBuild(
  catalog: WeaponCatalog,
  build: WeaponBuild,
): BuildValidationResult {
  const index = itemIndex(catalog);
  const issues: BuildIssue[] = [];
  const weapon = index.get(build.weaponId);
  if (!catalog.weaponIds.includes(build.weaponId) || weapon?.kind !== "weapon") {
    issues.push({
      code: "UNKNOWN_WEAPON",
      message: `Catalog weapon ${build.weaponId} does not exist.`,
      itemId: build.weaponId,
    });
  }
  if (build.root.itemId !== build.weaponId) {
    issues.push({
      code: "ROOT_ITEM_MISMATCH",
      message: `Build root ${build.root.itemId} does not match ${build.weaponId}.`,
      instanceId: build.root.instanceId,
      itemId: build.root.itemId,
    });
  }

  const seenInstances = new Set<string>();
  const flatNodes: FlatBuildNode[] = [];
  const visit = (
    node: BuildNode,
    parent: BuildNode | undefined,
    depth: number,
  ): void => {
    if (seenInstances.has(node.instanceId)) {
      issues.push({
        code: "DUPLICATE_INSTANCE_ID",
        message: `Instance ${node.instanceId} appears more than once.`,
        instanceId: node.instanceId,
        itemId: node.itemId,
      });
    }
    seenInstances.add(node.instanceId);
    flatNodes.push({
      instanceId: node.instanceId,
      itemId: node.itemId,
      parentInstanceId: parent?.instanceId ?? null,
      slotId: node.slotId ?? null,
      depth,
    });

    const item = index.get(node.itemId);
    if (!item) {
      issues.push({
        code: "UNKNOWN_ITEM",
        message: `Catalog item ${node.itemId} does not exist.`,
        instanceId: node.instanceId,
        itemId: node.itemId,
      });
    }

    if (parent) {
      const parentItem = index.get(parent.itemId);
      const slot = parentItem?.slots?.find((candidate) => candidate.id === node.slotId);
      if (!slot) {
        issues.push({
          code: "UNKNOWN_SLOT",
          message: `Slot ${node.slotId ?? "(missing)"} does not exist on ${parent.itemId}.`,
          instanceId: node.instanceId,
          itemId: node.itemId,
          parentInstanceId: parent.instanceId,
          slotId: node.slotId,
        });
      } else if (item) {
        issues.push(...slotRuleIssues(slot, item, parent.instanceId));
      }
    }

    const occupiedSlots = new Set<string>();
    for (const child of node.children) {
      if (child.slotId && occupiedSlots.has(child.slotId)) {
        issues.push({
          code: "DUPLICATE_SLOT",
          message: `Slot ${child.slotId} is occupied more than once.`,
          instanceId: child.instanceId,
          itemId: child.itemId,
          parentInstanceId: node.instanceId,
          slotId: child.slotId,
        });
      }
      if (child.slotId) occupiedSlots.add(child.slotId);
    }
    for (const slot of item?.slots ?? []) {
      if (slot.required && !occupiedSlots.has(slot.id)) {
        issues.push({
          code: "MISSING_REQUIRED_SLOT",
          message: `Required slot ${slot.id} is empty on ${item?.id}.`,
          instanceId: node.instanceId,
          itemId: node.itemId,
          slotId: slot.id,
        });
      }
    }

    for (const child of node.children) visit(child, node, depth + 1);
  };
  visit(build.root, undefined, 0);

  for (let leftIndex = 0; leftIndex < flatNodes.length; leftIndex += 1) {
    const left = flatNodes[leftIndex];
    const leftItem = index.get(left.itemId);
    if (!leftItem) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < flatNodes.length; rightIndex += 1) {
      const right = flatNodes[rightIndex];
      const rightItem = index.get(right.itemId);
      if (!rightItem) continue;
      issues.push(...pairConflictIssues(left, leftItem, right, rightItem));
    }
  }

  return { isValid: issues.length === 0, issues };
}

export function calculateBuildStats(
  catalog: WeaponCatalog,
  build: WeaponBuild,
): WeaponStats {
  const index = itemIndex(catalog);
  const weapon = index.get(build.weaponId);
  if (!weapon || weapon.kind !== "weapon") {
    throw new Error(`Catalog weapon ${build.weaponId} does not exist.`);
  }

  const result: WeaponStats = {
    verticalRecoil: weapon.baseStats.verticalRecoil,
    horizontalRecoil: weapon.baseStats.horizontalRecoil,
    ergonomics: weapon.baseStats.ergonomics,
    weight: weapon.baseStats.weight,
  };
  let recoilModifier = 0;
  let centerOfImpact = weapon.baseStats.centerOfImpact ?? 0;
  let hasCenterOfImpact = weapon.baseStats.centerOfImpact !== undefined;
  let muzzleVelocityModifier = 0;
  for (const node of flattenBuildTree(build.root).slice(1)) {
    const item = index.get(node.itemId);
    if (!item || item.kind !== "part" || !item.stats) continue;
    recoilModifier += item.stats.recoilModifier ?? 0;
    result.ergonomics += item.stats.ergonomics ?? 0;
    result.weight += item.stats.weight ?? 0;
    if (item.stats.centerOfImpact !== undefined) {
      centerOfImpact += item.stats.centerOfImpact;
      hasCenterOfImpact = true;
    }
    muzzleVelocityModifier += item.stats.muzzleVelocityModifier ?? 0;
  }
  result.verticalRecoil *= 1 + recoilModifier / 100;
  result.horizontalRecoil *= 1 + recoilModifier / 100;
  if (hasCenterOfImpact) {
    result.accuracyMoa = centerOfImpactToMoa(centerOfImpact);
  }
  if (muzzleVelocityModifier !== 0) result.muzzleVelocityModifier = muzzleVelocityModifier;
  return result;
}

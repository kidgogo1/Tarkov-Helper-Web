import { useEffect, useState } from "react";
import type { BuildNode } from "../../types/weapon-modding";

/** Integer yaw in degrees, from -180 to 180 inclusive in 15-degree steps. Validated at runtime, never rounded. */
export type PreviewAngle = number;
interface PreviewResult { key: string; imageUrl?: string; error?: string }
let pending: Promise<unknown> = Promise.resolve();

const ERRORS: Record<string, string> = {
  RATE_LIMITED: "이미지 서비스 호출 제한입니다. 잠시 뒤 직접 다시 시도해 주세요.",
  PREVIEW_BUSY: "다른 이미지를 생성 중입니다. 잠시 뒤 다시 시도해 주세요.",
  SLOT_UNAVAILABLE: "이미지 서비스가 이 부품 또는 장착 위치를 지원하지 않습니다.",
  INVALID_BUILD: "이 조립 구성을 이미지로 전달할 수 없습니다.",
  PROVIDER_TIMEOUT: "이미지 생성 시간이 초과됐습니다. 잠시 뒤 다시 시도해 주세요.",
  PROVIDER_RESPONSE: "이미지 서비스의 응답을 확인할 수 없습니다.",
  PROVIDER_UNAVAILABLE: "이미지 서비스에 연결할 수 없습니다. 기본 외형을 표시합니다.",
};

function previewNode(node: BuildNode): BuildNode {
  return { instanceId: node.instanceId, itemId: node.itemId,
    ...(node.slotId ? { slotId: node.slotId } : {}), children: node.children.map(previewNode) };
}

async function requestPreview(body: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api/modding/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body, signal: controller.signal, credentials: "same-origin",
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("이 실행 환경은 조립 미리보기를 지원하지 않습니다. 새 포터블 프로그램 또는 개발 서버에서 이용해 주세요.");
    }
    const text = await response.text();
    if (text.length > 7_100_000) throw new Error(ERRORS.PROVIDER_RESPONSE);
    const result: unknown = JSON.parse(text);
    if (!result || typeof result !== "object") throw new Error(ERRORS.PROVIDER_RESPONSE);
    if (!response.ok) {
      const code = "error" in result && result.error && typeof result.error === "object" &&
        "code" in result.error && typeof result.error.code === "string" ? result.error.code : "";
      throw new Error(ERRORS[code] ?? ERRORS.PROVIDER_UNAVAILABLE);
    }
    if (!("imageUrl" in result) || typeof result.imageUrl !== "string" ||
      !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(result.imageUrl)) {
      throw new Error(ERRORS.PROVIDER_RESPONSE);
    }
    return result.imageUrl;
  } finally { clearTimeout(timeout); }
}

export function useWeaponPreview(root: BuildNode, enabled: boolean, angle: PreviewAngle) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const body = JSON.stringify({ root: previewNode(root), angle });
  const key = `${body}:${attempt}`;
  const validAngle = Number.isInteger(angle) && angle >= -180 && angle <= 180 && angle % 15 === 0;
  useEffect(() => {
    if (!enabled || !validAngle) return;
    let active = true;
    const timer = setTimeout(() => {
      // One actual request at a time. Obsolete queued builds never reach the provider.
      // Do not cancel an already dispatched build: the server may still be rendering it.
      pending = pending.catch(() => undefined).then(async () => {
        if (!active) return;
        try {
          const imageUrl = await requestPreview(body);
          if (active) setResult({ key, imageUrl });
        } catch (error) {
          if (active) setResult({ key, error: error instanceof Error &&
            (Object.values(ERRORS).includes(error.message) || error.message.startsWith("이 실행 환경"))
            ? error.message : ERRORS.PROVIDER_UNAVAILABLE });
        }
      });
    }, 1_500);
    return () => { active = false; clearTimeout(timer); };
  }, [body, key, enabled, validAngle]);
  // A new tree or angle must never show the last successful image as current.
  const current = enabled && result?.key === key ? result : null;
  const error = enabled && !validAngle ? "각도는 -180도부터 180도까지 15도 간격으로 선택해 주세요." : current?.error;
  return {
    imageUrl: current?.imageUrl,
    error,
    status: !enabled ? "off" : error ? "error" : current?.imageUrl ? "ready" : "loading",
    retry: () => setAttempt((value) => value + 1),
  } as const;
}

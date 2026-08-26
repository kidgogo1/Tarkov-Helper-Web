import { Dialog } from "../../components/Dialog";
import type { WeaponPartItem } from "../../types/weapon-modding";
import { WeaponItemImage } from "./WeaponItemImage";

interface PartImagePreviewDialogProps {
  item: WeaponPartItem | null;
  onClose: () => void;
}

export function PartImagePreviewDialog({ item, onClose }: PartImagePreviewDialogProps) {
  if (!item) return null;
  const displayName = item.nameKo ?? item.name;
  return (
    <Dialog
      description="목록의 작은 아이콘보다 큰 원본 부품 이미지입니다."
      onClose={onClose}
      open
      title={`${displayName} 이미지`}
      wide
    >
      <figure className="modding-part-preview-dialog">
        <WeaponItemImage
          alt={`${displayName} 크게 보기`}
          fallbackSize={48}
          src={item.imageUrl ?? item.iconUrl}
        />
        <figcaption>
          <strong>{displayName}</strong>
          <span>{item.shortName ?? item.nameEn ?? item.name}</span>
        </figcaption>
      </figure>
    </Dialog>
  );
}

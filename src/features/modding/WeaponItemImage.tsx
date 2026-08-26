import { ImageOff } from "lucide-react";
import { useState, type ImgHTMLAttributes } from "react";

interface WeaponItemImageProps {
  alt: string;
  fallbackSize?: number;
  loading?: ImgHTMLAttributes<HTMLImageElement>["loading"];
  src?: string;
}

export function WeaponItemImage({
  alt,
  fallbackSize = 24,
  loading,
  src,
}: WeaponItemImageProps) {
  const [failedSource, setFailedSource] = useState<string>();
  if (!src || failedSource === src) {
    return (
      <ImageOff
        aria-hidden={alt ? undefined : true}
        aria-label={alt ? `${alt} 이미지 없음` : undefined}
        role={alt ? "img" : undefined}
        size={fallbackSize}
      />
    );
  }
  return (
    <img
      alt={alt}
      loading={loading}
      onError={() => setFailedSource(src)}
      src={src}
    />
  );
}

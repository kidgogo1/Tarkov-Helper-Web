import type { ReactNode } from "react";

interface MapMarkerLayerPanelProps {
  ariaLabel: string;
  children: ReactNode;
  className: string;
  eyebrow: string;
}

export function MapMarkerLayerPanel({
  ariaLabel,
  children,
  className,
  eyebrow,
}: MapMarkerLayerPanelProps) {
  return (
    <section
      aria-label={ariaLabel}
      className={`${className} map-marker-layer-panel`}
      role="group"
    >
      <header className="map-marker-layer-heading">
        <p>{eyebrow}</p>
        <h2>마커 표시</h2>
      </header>
      <div className="map-marker-layer-grid">{children}</div>
    </section>
  );
}

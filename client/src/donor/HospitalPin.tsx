// Hospital location on a map, when maps are available. The address is rendered
// by the caller either way, so a missing SDK costs the pin and nothing else.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { loadMapsApi } from '../lib/maps';
import { Skeleton } from '../ui';

const PIN_ZOOM = 15;

type PinStatus = 'checking' | 'ready' | 'unavailable';

export interface HospitalPinProps {
  name: string;
  lat: number;
  lng: number;
}

export function HospitalPin({ name, lat, lng }: HospitalPinProps): ReactElement | null {
  const [status, setStatus] = useState<PinStatus>('checking');
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const maps = await loadMapsApi();
      if (!live) return;
      const container = containerRef.current;
      if (maps === null || container === null) {
        setStatus('unavailable');
        return;
      }
      const map = new maps.Map(container, {
        center: { lat, lng },
        zoom: PIN_ZOOM,
        disableDefaultUI: true,
        clickableIcons: false,
      });
      new maps.Marker({ position: { lat, lng }, map, title: name });
      setStatus('ready');
    })();
    return () => {
      live = false;
    };
  }, [name, lat, lng]);

  // No map, no placeholder: the address above is the answer, and an empty grey
  // slab would only take the eye off the accept action.
  if (status === 'unavailable') return null;

  return (
    <>
      {status === 'checking' ? <Skeleton height="240px" radius="card" /> : null}
      <div
        ref={containerRef}
        className="donor-map"
        hidden={status !== 'ready'}
        role="img"
        aria-label={`Map showing ${name}`}
      />
    </>
  );
}

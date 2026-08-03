// Area picker: map tap, or typed coordinates when maps are unavailable.
//
// Both paths call encodeGeohash5 before anything is handed upward. The raw
// point exists only inside this component (a ref for the marker) and is never
// stored in state that reaches a request body.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { coordinateProblem, encodeGeohash5 } from '../lib/geohash';
import { loadMapsApi, type LatLngLiteral, type MapsMarker } from '../lib/maps';
import { Banner, Button, Field, Skeleton } from '../ui';

/** Centre of the contiguous US: this build's jurisdiction. */
const DEFAULT_CENTER: LatLngLiteral = { lat: 39.8283, lng: -98.5795 };
const DEFAULT_ZOOM = 4;

const MAP_UNAVAILABLE = 'The map could not load. Type your coordinates instead.';
const NEED_BOTH = 'Enter a number for both latitude and longitude.';

type MapStatus = 'checking' | 'ready' | 'unavailable';

export interface LocationPickerProps {
  /** The chosen cell, or null before a first pick. */
  value: string | null;
  onChange: (geohash5: string) => void;
}

export function LocationPicker({ value, onChange }: LocationPickerProps): ReactElement {
  const [status, setStatus] = useState<MapStatus>('checking');
  const [manual, setManual] = useState(false);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<MapsMarker | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const maps = await loadMapsApi();
      if (!live) return;
      const container = containerRef.current;
      if (maps === null || container === null) {
        setStatus('unavailable');
        setManual(true);
        return;
      }
      const map = new maps.Map(container, {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        disableDefaultUI: true,
        clickableIcons: false,
      });
      map.addListener('click', (event) => {
        const point = event.latLng;
        if (point === undefined || point === null) return;
        // Truncated here, on device. The pair below never leaves this closure.
        const picked: LatLngLiteral = { lat: point.lat(), lng: point.lng() };
        if (markerRef.current === null) {
          markerRef.current = new maps.Marker({ position: picked, map, title: 'Your area' });
        } else {
          markerRef.current.setPosition(picked);
        }
        onChange(encodeGeohash5(picked.lat, picked.lng));
      });
      setStatus('ready');
    })();
    return () => {
      live = false;
    };
  }, [onChange]);

  function applyManual(): void {
    const problem = coordinateProblem(Number(lat), Number(lng));
    if (lat.trim() === '' || lng.trim() === '') {
      setManualError(NEED_BOTH);
      return;
    }
    if (problem !== null) {
      setManualError(problem);
      return;
    }
    setManualError(null);
    onChange(encodeGeohash5(Number(lat), Number(lng)));
  }

  return (
    <div className="picker">
      {status === 'checking' ? (
        <Skeleton height="240px" radius="card" label="Loading the map" />
      ) : null}
      {status === 'unavailable' ? (
        <Banner tone="warn" role="alert">
          {MAP_UNAVAILABLE}
        </Banner>
      ) : null}

      <div
        ref={containerRef}
        className="donor-map"
        hidden={status !== 'ready'}
        aria-label="Tap your area on the map"
        role="group"
      />

      {status === 'ready' && !manual ? (
        <div className="picker-actions">
          <Button variant="ghost" onClick={() => setManual(true)}>
            Type coordinates instead
          </Button>
        </div>
      ) : null}

      {manual ? (
        <>
          <div className="manual-grid">
            <Field
              id="lat"
              name="lat"
              label="Latitude"
              type="text"
              inputMode="decimal"
              value={lat}
              onChange={(event) => setLat(event.target.value)}
            />
            <Field
              id="lng"
              name="lng"
              label="Longitude"
              type="text"
              inputMode="decimal"
              value={lng}
              onChange={(event) => setLng(event.target.value)}
            />
          </div>
          <div className="picker-actions">
            <Button variant="secondary" onClick={applyManual}>
              Set my area
            </Button>
          </div>
          {manualError === null ? null : <Banner tone="error">{manualError}</Banner>}
        </>
      ) : null}

      <p className="picker-state">
        {value === null ? 'No area chosen yet.' : `Your area cell: ${value}`}
      </p>
    </div>
  );
}

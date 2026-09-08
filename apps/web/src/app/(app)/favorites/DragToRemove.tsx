'use client';

import { Icon } from '@mbolo/ui';
import { create } from 'zustand';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

// Retrait d'un favori en glissant la tuile vers la corbeille (façon iOS) :
// souris — le drag démarre dès 6 px de mouvement ; tactile — appui long
// (~280 ms) pour ne pas entrer en conflit avec le scroll vertical de la page.
// La corbeille (TrashZone) s'affiche au engage ; le retrait ne part qu'au
// relâchement dans la zone — sinon la tuile retourne à sa place.

interface DragTrashState {
  /** Un drag est en cours (une seule tuile à la fois — store global). */
  active: boolean;
  label: string | null;
  /** Le pointeur survole la corbeille. */
  over: boolean;
  zone: HTMLElement | null;
  begin: (label: string) => void;
  setOver: (over: boolean) => void;
  end: () => void;
  setZone: (zone: HTMLElement | null) => void;
}

export const useDragTrashStore = create<DragTrashState>((set) => ({
  active: false,
  label: null,
  over: false,
  zone: null,
  begin: (label) => set({ active: true, label, over: false }),
  setOver: (over) => set({ over }),
  end: () => set({ active: false, label: null, over: false }),
  setZone: (zone) => set({ zone }),
}));

const MOUSE_ENGAGE_PX = 6;
const TOUCH_ENGAGE_MS = 280;
const TRASH_MARGIN_PX = 12;

export function DragToRemove({ label, onRemove, children }: { label: string; onRemove: () => void; children: ReactNode }) {
  const [dragging, setDragging] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const engaged = useRef(false);
  const overTrash = useRef(false);
  const pressTimer = useRef(0);
  const removeTimer = useRef(0);
  /** Le pointerup qui suit un engage ne doit pas déclencher le clic-lien. */
  const suppressClick = useRef(false);

  useEffect(
    () => () => {
      window.clearTimeout(pressTimer.current);
      window.clearTimeout(removeTimer.current);
    },
    [],
  );

  const clearPressTimer = (): void => window.clearTimeout(pressTimer.current);

  const pointOverTrash = (x: number, y: number): boolean => {
    const zone = useDragTrashStore.getState().zone;
    if (!zone) return false;
    const rect = zone.getBoundingClientRect();
    return x >= rect.left - TRASH_MARGIN_PX && x <= rect.right + TRASH_MARGIN_PX && y >= rect.top - TRASH_MARGIN_PX && y <= rect.bottom + TRASH_MARGIN_PX;
  };

  const engage = (): void => {
    if (engaged.current || removed) return;
    engaged.current = true;
    suppressClick.current = true;
    setDragging(true);
    useDragTrashStore.getState().begin(label);
    try {
      if (pointerId.current !== null) wrapRef.current?.setPointerCapture(pointerId.current);
    } catch {
      // Capture refusée (pointer déjà relâché) : le drag suit quand même.
    }
  };

  // Tactile : une fois engagé, avaler les touchmove empêche le navigateur de
  // transformer le geste en scroll (et de nous envoyer un pointercancel) ;
  // avant l'engage, le moindre mouvement annule l'appui long — le scroll
  // reprend ses droits normalement.
  const onWindowTouchMove = (event: TouchEvent): void => {
    if (engaged.current) {
      event.preventDefault();
      return;
    }
    clearPressTimer();
  };

  const onWindowPointerUp = (event: PointerEvent): void => {
    if (pointerId.current !== event.pointerId) return;
    finish(false);
  };

  const onWindowPointerCancel = (event: PointerEvent): void => {
    if (pointerId.current !== event.pointerId) return;
    finish(true);
  };

  const finish = (cancelled: boolean): void => {
    window.removeEventListener('touchmove', onWindowTouchMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerCancel);
    clearPressTimer();
    const wasEngaged = engaged.current;
    engaged.current = false;
    pointerId.current = null;
    if (!wasEngaged) return;
    const wasOver = overTrash.current;
    useDragTrashStore.getState().end();
    if (!cancelled && wasOver) {
      // Anim de sortie avant le retrait réel : le wrapper reste monté le
      // temps du scale-out, puis la liste se referme.
      setRemoved(true);
      removeTimer.current = window.setTimeout(onRemove, 180);
      return;
    }
    setDragging(false);
    setOffset({ x: 0, y: 0 });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (removed || event.button !== 0 || pointerId.current !== null) return;
    pointerId.current = event.pointerId;
    origin.current = { x: event.clientX, y: event.clientY };
    window.addEventListener('touchmove', onWindowTouchMove, { passive: false });
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerCancel);
    if (event.pointerType !== 'mouse') {
      clearPressTimer();
      pressTimer.current = window.setTimeout(engage, TOUCH_ENGAGE_MS);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointerId.current !== event.pointerId) return;
    const dx = event.clientX - origin.current.x;
    const dy = event.clientY - origin.current.y;
    if (!engaged.current) {
      // Souris uniquement : le tactile passe par l'appui long (le premier
      // mouvement tactile est réservé au scroll).
      if (event.pointerType === 'mouse' && Math.hypot(dx, dy) >= MOUSE_ENGAGE_PX) engage();
      return;
    }
    setOffset({ x: dx, y: dy });
    const over = pointOverTrash(event.clientX, event.clientY);
    overTrash.current = over;
    useDragTrashStore.getState().setOver(over);
  };

  return (
    <div
      ref={wrapRef}
      className={dragging ? 'relative z-50 cursor-grabbing' : 'relative'}
      style={{
        transform: removed ? 'scale(0.55)' : dragging ? `translate(${offset.x}px, ${offset.y}px) scale(1.05)` : undefined,
        opacity: removed ? 0 : dragging ? 0.9 : 1,
        transition: dragging ? 'none' : 'transform 200ms ease, opacity 180ms ease',
        WebkitTouchCallout: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      // Le drag natif d'image (ghost HTML5) ferait double emploi.
      onDragStart={(event) => event.preventDefault()}
      onContextMenu={(event) => {
        if (engaged.current) event.preventDefault();
      }}
      onClickCapture={(event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      aria-label={`${label} — glisser vers la corbeille pour retirer des favoris`}
    >
      {children}
    </div>
  );
}

/** Corbeille fixe affichée pendant un drag ; la cible est mesurée par les
 * DragToRemove (rect lu à chaque move — la zone est immobile pendant le
 * geste, getBoundingClientRect est négligeable à cette fréquence). */
export function TrashZone() {
  const active = useDragTrashStore((state) => state.active);
  const over = useDragTrashStore((state) => state.over);
  const label = useDragTrashStore((state) => state.label);
  const setZone = useDragTrashStore((state) => state.setZone);
  const zoneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setZone(zoneRef.current);
    return () => setZone(null);
  }, [setZone, active]);

  if (!active) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-[100] flex justify-center">
      <div
        ref={zoneRef}
        role="status"
        aria-label={over ? `Relâche pour retirer ${label ?? 'le favori'}` : `Glisse ${label ?? 'le favori'} ici pour le retirer`}
        className={`flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-full border-2 shadow-xl backdrop-blur transition-[transform,background-color,border-color,color] duration-150 ${
          over ? 'scale-125 border-danger bg-danger text-white' : 'scale-100 border-border bg-surface/95 text-muted'
        }`}
      >
        <Icon.Trash2 size={26} aria-hidden />
        <span className="text-[10px] font-bold uppercase tracking-wide">{over ? 'Relâche' : 'Retirer'}</span>
      </div>
    </div>
  );
}

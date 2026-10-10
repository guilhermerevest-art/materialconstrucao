import { Eraser } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Button } from './ui/button';

export type SignaturePadHandle = {
  /** PNG da assinatura, ou nulo se ninguém assinou. */
  toDataUrl: () => string | null;
  clear: () => void;
};

/** Quadro para assinar com o dedo (ou o mouse). */
export function SignaturePad({ ref, onChange }: { ref?: Ref<SignaturePadHandle>; onChange?: (signed: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const signed = useRef(false);

  // O canvas desenha na resolução da tela (nítido no celular), mas o tamanho visível é o do CSS.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1B2631';
  }, []);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    signed.current = false;
    onChange?.(false);
  }

  useImperativeHandle(ref, () => ({
    toDataUrl: () => (signed.current ? canvasRef.current!.toDataURL('image/png') : null),
    clear,
  }));

  return (
    <div className="grid gap-2">
      <canvas
        ref={canvasRef}
        aria-label="Assinatura de quem recebeu"
        className="h-44 w-full touch-none rounded-md border border-dashed border-input bg-card"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drawing.current = true;
          const ctx = canvasRef.current!.getContext('2d')!;
          const { x, y } = point(event);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 0.1, y + 0.1);
          ctx.stroke();
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const ctx = canvasRef.current!.getContext('2d')!;
          const { x, y } = point(event);
          ctx.lineTo(x, y);
          ctx.stroke();
          if (!signed.current) {
            signed.current = true;
            onChange?.(true);
          }
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      />
      <Button type="button" variant="ghost" size="sm" className="justify-self-end" onClick={clear}>
        <Eraser />
        Limpar assinatura
      </Button>
    </div>
  );
}

// O servidor aceita até 600 KB de foto: reduz no celular antes de enviar.
const MAX_PHOTO_CHARS = 780_000;

/** Foto da câmera reduzida para no máximo 1280 px e JPEG, que é o que o 4G aguenta. */
export async function compressPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  for (const [side, quality] of [
    [1280, 0.72],
    [1024, 0.6],
    [800, 0.5],
  ] as const) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', quality);
    if (data.length <= MAX_PHOTO_CHARS) return data;
  }
  throw new Error('A foto ficou grande demais. Tire outra mais de perto.');
}

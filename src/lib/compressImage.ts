const MAX_WIDTH = 1920;
const JPEG_QUALITY = 0.85;

/** Try <img> + canvas compression.
 *  Returns null on any failure (timeout, zero dimensions, toBlob errors).
 *
 *  Front-camera / portrait-mode HEIC on iOS can cause img.onload or canvas.toBlob
 *  to hang indefinitely. The 8 s timeout lets the createImageBitmap fallback kick in. */
function compressViaImg(file: File): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        URL.revokeObjectURL(url);
        resolve(null);
      }
    }, 8_000);

    img.onload = () => {
      if (settled) return;
      URL.revokeObjectURL(url);

      // Guard against zero-dimension images (HEIC orientation quirks on iOS,
      // especially mirrored front-camera photos).
      if (!img.width || !img.height) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
        return;
      }

      const scale = img.width > MAX_WIDTH ? MAX_WIDTH / img.width : 1;
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);

      canvas.toBlob(
        (blob) => {
          settled = true;
          clearTimeout(timer);
          if (!blob) { resolve(null); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
            type: "image/jpeg",
            lastModified: file.lastModified,
          }));
        },
        "image/jpeg",
        JPEG_QUALITY,
      );
    };

    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Compresses an image client-side using Canvas.
 *  Phase 1: <img> decode (fast path, works for most JPEG/PNG/HEIC).
 *  Phase 2: createImageBitmap — handles mirror-flipped / portrait-mode HEIC on iOS
 *           that cause the <img> decode path to hang or produce zero dimensions.
 *  Resizes to max 1920px width, converts to JPEG 85%.
 *  Returns a new File with the same lastModified (for EXIF fallback). */
export async function compressImage(file: File): Promise<File> {
  // Phase 1: standard <img> + canvas path
  const imgResult = await compressViaImg(file);
  if (imgResult) return imgResult;

  // Phase 2: createImageBitmap — decodes off-main-thread, handles more HEIC variants
  const bitmap = await createImageBitmap(file); // throws if format is unsupported
  if (!bitmap.width || !bitmap.height) {
    bitmap.close();
    throw new Error("ImageBitmap has zero dimensions");
  }

  const scale = bitmap.width > MAX_WIDTH ? MAX_WIDTH / bitmap.width : 1;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return new Promise<File>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error("Canvas toBlob failed (bitmap path)")); return; }
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
          type: "image/jpeg",
          lastModified: file.lastModified,
        }));
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

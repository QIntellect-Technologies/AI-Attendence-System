/**
 * Turns a user-picked image into a small data URL suitable for the company
 * logo. The logo is stored inline and shipped in every bootstrap response, so
 * it is downscaled here instead of uploading whatever the camera roll holds.
 * Limits mirror _validate_logo_data_url in support_db_client_users.py.
 */
export const LOGO_MAX_DIMENSION = 256;
const LOGO_MAX_INPUT_BYTES = 5 * 1024 * 1024;
// ~285 KB decoded — safely under the server's 300 KB cap.
const LOGO_MAX_DATA_URL_CHARS = 380_000;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read this image."));
    };
    img.src = url;
  });
}

export async function imageFileToLogoDataUrl(file: File): Promise<string> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new Error("Logo must be a PNG, JPG or WebP image.");
  }
  if (file.size > LOGO_MAX_INPUT_BYTES) {
    throw new Error("Image is larger than 5 MB.");
  }

  const img = await loadImage(file);
  const scale = Math.min(
    1,
    LOGO_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process this image.");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // PNG keeps transparency; WebP is the fallback for unusually detailed images.
  for (const type of ["image/png", "image/webp"]) {
    const dataUrl = canvas.toDataURL(type, 0.9);
    if (
      dataUrl.startsWith(`data:${type}`) &&
      dataUrl.length <= LOGO_MAX_DATA_URL_CHARS
    ) {
      return dataUrl;
    }
  }
  throw new Error("Image is too detailed. Use a simpler or smaller logo.");
}

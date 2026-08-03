// stub สำหรับ deno check เท่านั้น — ไม่ใช้ตอนรันจริง
export function initWasm(_mod: unknown): Promise<void> { return Promise.resolve(); }
export class Resvg {
  constructor(_svg: string, _opts?: unknown) {}
  // ของจริงคืน RenderedImage (มี asPng(), pixels, width, height) — ปล่อย any ให้เช็คผ่านแบบเดียวกับ lib จริงบน esm.sh ที่ไม่มี dts
  render(): any { return null; }
}

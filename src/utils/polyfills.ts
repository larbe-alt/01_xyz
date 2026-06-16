if (typeof Uint8Array.prototype.toHex !== "function") {
  (Uint8Array.prototype as any).toHex = function () {
    return Array.from(this, (b: number) => b.toString(16).padStart(2, "0")).join("");
  };
}
if (typeof (Uint8Array as any).fromHex !== "function") {
  (Uint8Array as any).fromHex = function (hex: string) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  };
}

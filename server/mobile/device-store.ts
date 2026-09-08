import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
interface Device { id: string; name: string; tokenHash: string; createdAt: number; expiresAt: number }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class MobileDeviceStore {
  readonly readError?: string;
  private devices: Device[] = [];
  private pairing: { hash: string; expiresAt: number } | null = null;
  constructor(private file: string) {
    try { const data = JSON.parse(fs.readFileSync(file, "utf8")); if (data.version !== 1 || !Array.isArray(data.devices)) throw new Error("Invalid mobile devices"); this.devices = data.devices; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.readError = "Mobile device records are unreadable. Repair the local file before enabling mobile access."; }
  }
  private save() {
    if (this.readError) throw new Error(this.readError);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, devices: this.devices }), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, this.file);
  }
  list() { return this.devices.filter(device => device.expiresAt > Date.now()).map(({ tokenHash: _hash, ...device }) => device); }
  createPairing() { if (this.readError) throw new Error(this.readError); const code = randomBytes(24).toString("base64url"); const expiresAt = Date.now() + 300000; this.pairing = { hash: hash(code), expiresAt }; return { code, expiresAt }; }
  clearPairing() { this.pairing = null; }
  pair(code: string, name: string) {
    if (!this.pairing || this.pairing.expiresAt <= Date.now() || hash(code) !== this.pairing.hash) throw new Error("Invalid or expired pairing code");
    if (this.list().length >= 16) throw new Error("Device limit reached; remove an old device in Lynn settings");
    this.pairing = null;
    const token = randomBytes(32).toString("base64url");
    const cleanName = Array.from(name).filter(char => char.charCodeAt(0) >= 32).join('').slice(0, 80);
    const device: Device = { id: randomUUID(), name: cleanName || "Mobile", tokenHash: hash(token), createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000 };
    this.devices = this.devices.filter(item => item.expiresAt > Date.now()); this.devices.push(device); this.save();
    return { token, id: device.id };
  }
  authenticate(token: string) { if (!token || token.length > 128) return null; const digest = hash(token); return this.devices.find(device => device.tokenHash === digest && device.expiresAt > Date.now())?.id || null; }
  revoke(id: string) { this.devices = this.devices.filter(device => device.id !== id); this.save(); }
}

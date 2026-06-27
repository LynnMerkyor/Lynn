import path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadAdapter(adapterRef, options = {}) {
  if (!adapterRef) {
    throw new Error("Missing adapter. Pass --adapter <module> or provide an adapter object to runCaseBank().");
  }
  if (typeof adapterRef === "object" && typeof adapterRef.run === "function") return adapterRef;
  if (typeof adapterRef !== "string") throw new Error(`Unsupported adapter ref: ${typeof adapterRef}`);

  const { modulePath, exportName } = splitAdapterRef(adapterRef);
  const absolute = path.resolve(options.cwd || process.cwd(), modulePath);
  const mod = await import(pathToFileURL(absolute).href);
  const factory = resolveAdapterExport(mod, exportName);
  const adapter = typeof factory === "function" ? await factory(options.adapterOptions || {}) : factory;
  if (!adapter || typeof adapter.run !== "function") {
    throw new Error(`Adapter ${adapterRef} did not produce an object with run(operation, input, context)`);
  }
  return adapter;
}

function splitAdapterRef(ref) {
  const [modulePath, exportName] = String(ref).split("#");
  return { modulePath, exportName: exportName || "" };
}

function resolveAdapterExport(mod, exportName) {
  if (exportName) {
    if (!(exportName in mod)) throw new Error(`Adapter export not found: ${exportName}`);
    return mod[exportName];
  }
  if (mod.default) return mod.default;
  if (mod.createAdapter) return mod.createAdapter;
  const factoryName = Object.keys(mod).find((key) => /^create[A-Z].*Adapter$/.test(key));
  if (factoryName) return mod[factoryName];
  return mod.adapter;
}

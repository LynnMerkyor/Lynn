declare module "js-yaml" {
  export interface DumpOptions {
    indent?: number;
    lineWidth?: number;
    sortKeys?: boolean;
    quotingType?: "\"" | "'";
    forceQuotes?: boolean;
  }

  export function load(input: string): unknown;
  export function dump(input: unknown, options?: DumpOptions): string;

  const YAML: {
    load: typeof load;
    dump: typeof dump;
  };

  export default YAML;
}

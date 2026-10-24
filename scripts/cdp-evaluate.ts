import { randomUUID } from "node:crypto";

type CdpCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface Evaluation {
  exceptionDetails?: { text?: string; exception?: { description?: string } };
  result?: { subtype?: string; objectId?: string; value?: unknown };
}

function checked(value: Record<string, unknown>): Evaluation["result"] {
  const result = value as Evaluation;
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "CDP evaluation failed");
  }
  return result.result;
}

/** Keep the remote Promise alive until it settles; never rerun a mutating expression. */
export async function evaluateRetained(call: CdpCall, expression: string): Promise<unknown> {
  const objectGroup = `lynn-evaluate-${randomUUID()}`;
  try {
    const remote = checked(await call("Runtime.evaluate", {
      expression, awaitPromise: false, returnByValue: false, objectGroup,
    }));
    if (!remote?.objectId) return remote?.value;
    if (remote.subtype === "promise") {
      return checked(await call("Runtime.awaitPromise", {
        promiseObjectId: remote.objectId, returnByValue: true,
      }))?.value;
    }
    return checked(await call("Runtime.callFunctionOn", {
      objectId: remote.objectId, functionDeclaration: "function () { return this; }", returnByValue: true,
    }))?.value;
  } finally {
    await call("Runtime.releaseObjectGroup", { objectGroup });
  }
}

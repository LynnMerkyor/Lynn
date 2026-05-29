import { describe, expect, it } from "vitest";
import { extractGroundingBoxes } from "../src/vision-result.js";

describe("vision grounding result parser", () => {
  it("parses normalized boxes from fenced JSON", () => {
    expect(extractGroundingBoxes('```json\n{"x":0.25,"y":0.5,"w":0.2,"h":0.1,"confidence":0.88,"label":"submit"}\n```')).toEqual([{
      label: "submit",
      x: 0.25,
      y: 0.5,
      width: 0.2,
      height: 0.1,
      confidence: 0.88,
    }]);
  });

  it("skips bracketed prose before the first valid JSON object", () => {
    expect(extractGroundingBoxes("Look at [the primary button], then use {\"x\":0.4,\"y\":0.6,\"reason\":\"primary\"}.")).toEqual([{
      label: "primary",
      x: 0.4,
      y: 0.6,
    }]);
  });

  it("parses array and boxes wrapper shapes", () => {
    expect(extractGroundingBoxes('{"boxes":[{"label":"ok","bbox":[0.1,0.2,0.3,0.4]}]}')).toEqual([{
      label: "ok",
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    }]);
  });
});

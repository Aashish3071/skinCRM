import { describe, expect, it } from "vitest";
import {
  ALL_TEMPLATE_VARIABLE_NAMES,
  extractVariables,
  renderTemplate,
  validateTemplateBody,
} from "../render";

describe("template rendering (PRD MSG-02)", () => {
  it("substitutes supplied variables", () => {
    const result = renderTemplate("Hello {{person.firstName}}, see you at {{appointment.time}}.", {
      "person.firstName": "Marisol",
      "appointment.time": "10:00 AM",
    });
    expect(result.text).toBe("Hello Marisol, see you at 10:00 AM.");
    expect(result.missing).toEqual([]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Hi {{ person.firstName }}", { "person.firstName": "Ana" }).text).toBe(
      "Hi Ana",
    );
  });

  it("leaves a missing variable visible rather than blanking it", () => {
    const result = renderTemplate("Hello {{person.firstName}}", { "person.firstName": null });
    // A silent blank reads as finished text and goes out looking broken; the
    // token surviving makes the problem obvious before it is sent.
    expect(result.text).toBe("Hello {{person.firstName}}");
    expect(result.missing).toEqual(["person.firstName"]);
  });

  it("treats an empty string as missing", () => {
    expect(renderTemplate("Hi {{person.firstName}}", { "person.firstName": "" }).missing).toEqual([
      "person.firstName",
    ]);
  });

  it("reports each missing variable once", () => {
    const result = renderTemplate("{{a}} {{a}} {{b}}", {});
    expect(result.missing.sort()).toEqual(["a", "b"]);
  });

  it("does not evaluate anything beyond simple substitution", () => {
    const result = renderTemplate("{{person.firstName}}", {
      "person.firstName": "{{clinic.name}}",
    });
    // A value that looks like a token is inserted literally, not re-expanded.
    expect(result.text).toBe("{{clinic.name}}");
  });

  it("ignores malformed tokens", () => {
    expect(renderTemplate("{ not a token } {{}}", {}).text).toBe("{ not a token } {{}}");
  });
});

describe("template validation", () => {
  it("accepts a body using only allowed variables", () => {
    expect(validateTemplateBody("Hi {{person.firstName}}", ["person.firstName"]).valid).toBe(true);
  });

  it("rejects a body using an unknown variable", () => {
    const result = validateTemplateBody("Hi {{person.nickname}}", ["person.firstName"]);
    expect(result.valid).toBe(false);
    expect(result.unknownVariables).toEqual(["person.nickname"]);
  });

  it("extracts every distinct variable", () => {
    expect(extractVariables("{{a}} {{b}} {{a}}").sort()).toEqual(["a", "b"]);
  });
});

describe("the offered variable list", () => {
  it("offers nothing clinical, and nothing from General Notes", () => {
    const names = ALL_TEMPLATE_VARIABLE_NAMES.join(" ").toLowerCase();
    // PRD ID-08: notes are never inserted into an automated message.
    // PRD 8: service and condition stay out of message bodies and subjects.
    for (const forbidden of ["note", "service", "condition", "diagnosis", "treatment"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

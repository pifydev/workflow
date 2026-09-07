/**
 * Structured output for agent() (v0.3). A script that wants data back
 * currently gets prose and has to parse it — every caller reinventing the
 * same brittle extraction. With `schema`, the child is told to answer with
 * one JSON object, the answer is validated here, and the script receives a
 * real object.
 *
 * The validator is a deliberate subset of JSON Schema: the keywords a
 * workflow author actually writes (type, properties, required, items, enum,
 * bounds). Unknown keywords are ignored rather than rejected — a schema that
 * says more than we understand should still work, just with less checking.
 */

export type JsonSchema = Record<string, unknown>;

export function schemaInstruction(schema: JsonSchema): string {
  return [
    "Your entire final message must be ONE JSON object matching this schema, and nothing else:",
    JSON.stringify(schema),
    "No prose before or after it, no markdown fence, no explanation.",
  ].join("\n");
}

/** Pull a JSON value out of an answer that may be fenced or padded with prose. */
export function extractJson(text: string): unknown {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return undefined;

  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1]!.trim());
  candidates.push(trimmed);

  // Last resort: the outermost {...} or [...] span in the message.
  const firstBrace = trimmed.search(/[{[]/);
  const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === expected;
}

/**
 * Validate a value against the supported subset. Returns human-readable
 * errors (empty array = valid) — they are handed back to the child agent, so
 * they read as instructions rather than as codes.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "value"): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return errors;

  const expected = schema.type;
  if (typeof expected === "string" && !typeMatches(value, expected)) {
    errors.push(`${path} must be ${expected}, got ${typeOf(value)}`);
    return errors; // everything below assumes the type held
  }
  if (Array.isArray(expected) && !expected.some((t) => typeof t === "string" && typeMatches(value, t))) {
    errors.push(`${path} must be one of ${expected.join("|")}, got ${typeOf(value)}`);
    return errors;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    errors.push(`${path} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }

  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in object)) errors.push(`${path}.${key} is required`);
    }
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [key, sub] of Object.entries(properties)) {
      if (key in object) errors.push(...validateAgainstSchema(object[key], sub, `${path}.${key}`));
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path} needs at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path} allows at most ${schema.maxItems} item(s), got ${value.length}`);
    }
    const items = schema.items as JsonSchema | undefined;
    if (items && typeof items === "object") {
      value.forEach((item, index) => errors.push(...validateAgainstSchema(item, items, `${path}[${index}]`)));
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} must be at most ${schema.maxLength} characters`);
    }
  }

  return errors;
}

/**
 * A validation failure the child can act on: what to change, what proved it
 * wrong, and which repairs are legitimate.
 *
 * A bare list of messages leaves the model guessing at the repair space, and
 * a guessing model rewrites the parts that were already right. Naming the
 * subject and bounding the fixes is tt-a1i/archify's diagnostic shape
 * (subject / evidence / supportedFixes), and it costs nothing to carry.
 */
export interface Diagnostic {
  /** Dotted path of the offending value, e.g. "root.findings[2].file". */
  subject: string;
  /** The validator's own words for what is wrong. */
  evidence: string;
  /** Repairs that would satisfy the schema. */
  supportedFixes: string[];
}

/** Turn a validator message back into the parts a repair needs. */
export function toDiagnostic(message: string): Diagnostic {
  const subject = /^(\S+?)\s/.exec(message)?.[1] ?? "root";
  const rest = message.slice(subject.length).trim();
  const fixes: string[] = [];

  const listed = /must be one of (.+?), got|must be one of (.+)$/.exec(rest);
  const candidates = (listed?.[1] ?? listed?.[2] ?? "").trim();
  // "string|number" is a union of types; '"low", "high"' is a set of values.
  // They read the same in the message and need different repairs.
  const isTypeUnion = candidates.includes("|") && !candidates.includes('"');
  const typeMatch = /must be ([\w|]+), got (\w+)/.exec(rest);
  if (/is required$/.test(rest)) {
    fixes.push(`add ${subject}`);
  } else if (isTypeUnion) {
    fixes.push(`make ${subject} a ${candidates.replace(/\|/g, " or ")}`);
  } else if (typeMatch) {
    fixes.push(`make ${subject} a ${typeMatch[1]!.replace(/\|/g, " or ")}`);
  } else if (candidates) {
    fixes.push(`set ${subject} to one of ${candidates}`);
  } else if (/at least|at most|>=|<=/.test(rest)) {
    fixes.push(`adjust ${subject} so it satisfies: ${rest}`);
  } else {
    fixes.push(`correct ${subject}`);
  }
  // The repair that is never right, stated because models reach for it.
  fixes.push("keep every field that already validates unchanged");
  return { subject, evidence: rest || message, supportedFixes: fixes };
}

/** The one retry the child gets: what was wrong, and what to send instead. */
export function retryPrompt(errors: string[], schema: JsonSchema): string {
  const diagnostics = errors.slice(0, 8).map(toDiagnostic);
  return [
    "That answer did not match the required schema. Fix exactly these, nothing else:",
    ...diagnostics.map(
      (d) => `- subject: ${d.subject}\n  evidence: ${d.evidence}\n  fixes: ${d.supportedFixes.join("; ")}`,
    ),
    "",
    "Change one thing per diagnostic. Do not restructure the parts that already validated.",
    "",
    schemaInstruction(schema),
  ].join("\n");
}

export interface SchemaOutcome {
  ok: boolean;
  value: unknown;
  errors: string[];
}

/** Extract + validate in one step, for both the first answer and the retry. */
export function readStructured(text: string, schema: JsonSchema): SchemaOutcome {
  const value = extractJson(text);
  if (value === undefined) {
    return { ok: false, value: undefined, errors: ["the answer contained no JSON value"] };
  }
  const errors = validateAgainstSchema(value, schema);
  return { ok: errors.length === 0, value, errors };
}

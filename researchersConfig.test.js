import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResearchersConfig } from "./researchersConfig.js";

test("normalizeResearchersConfig trims handles and removes duplicates case-insensitively", () => {
    const normalized = normalizeResearchersConfig({
        researchers: [
            { handle: " alice " },
            { handle: "ALICE" },
            { handle: "bob" },
            { handle: "" },
            {},
        ],
        lsr: " alice ",
    });

    assert.deepEqual(normalized, {
        researchers: [{ handle: "alice" }, { handle: "bob" }],
        lsr: "alice",
    });
});

test("normalizeResearchersConfig clears lsr when it is not in the saved researcher list", () => {
    const normalized = normalizeResearchersConfig({
        researchers: [{ handle: "alice" }],
        lsr: "charlie",
    });

    assert.deepEqual(normalized, {
        researchers: [{ handle: "alice" }],
        lsr: null,
    });
});

test("normalizeResearchersConfig handles missing or invalid payloads", () => {
    assert.deepEqual(normalizeResearchersConfig(null), {
        researchers: [],
        lsr: null,
    });

    assert.deepEqual(
        normalizeResearchersConfig({
            researchers: [" one ", "two"],
            lsr: "TWO",
        }),
        {
            researchers: [{ handle: "one" }, { handle: "two" }],
            lsr: "two",
        },
    );

    assert.deepEqual(
        normalizeResearchersConfig({
            researchers: ["valid-handle", "<script>alert(1)</script>", "-bad-"],
            lsr: "<script>alert(1)</script>",
        }),
        {
            researchers: [{ handle: "valid-handle" }],
            lsr: null,
        },
    );
});

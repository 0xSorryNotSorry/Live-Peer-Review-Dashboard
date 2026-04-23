export function normalizeResearchersConfig(input) {
    const rawResearchers = Array.isArray(input?.researchers) ? input.researchers : [];
    const normalizedResearchers = [];
    const seenHandles = new Set();

    for (const entry of rawResearchers) {
        const rawHandle = typeof entry === "string" ? entry : entry?.handle;
        const handle = normalizeHandle(rawHandle);
        if (!handle) {
            continue;
        }

        const key = handle.toLowerCase();
        if (seenHandles.has(key)) {
            continue;
        }

        seenHandles.add(key);
        normalizedResearchers.push({ handle });
    }

    const requestedLsr = normalizeHandle(input?.lsr);
    const lsrMatch = requestedLsr
        ? normalizedResearchers.find(
              (researcher) => researcher.handle.toLowerCase() === requestedLsr.toLowerCase(),
          )
        : null;

    return {
        researchers: normalizedResearchers,
        lsr: lsrMatch ? lsrMatch.handle : null,
    };
}

function normalizeHandle(value) {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    if (!/^[A-Za-z0-9-]{1,39}$/.test(trimmed)) {
        return null;
    }

    if (trimmed.startsWith("-") || trimmed.endsWith("-")) {
        return null;
    }

    return trimmed;
}

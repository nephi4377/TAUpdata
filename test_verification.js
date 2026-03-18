const v1 = "2.6.402";
const v2 = "2.6.402";

function compareVersions(v1, v2) {
    if (!v1) return -1;
    if (!v2) return 1;
    const clean = (v) => v.toString().replace(/^v/i, '').split('-')[0];
    const parts1 = clean(v1).split('.').map(part => parseInt(part, 10) || 0);
    const parts2 = clean(v2).split('.').map(part => parseInt(part, 10) || 0);
    const length = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < length; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

const patchVersion = v1;
const baseVersion = v2;

console.log(`Current Patch: ${patchVersion}`);
console.log(`Current Base: ${baseVersion}`);
console.log(`Compare Result (0 means equal): ${compareVersions(patchVersion, baseVersion)}`);

// Simulate the fix: if (patchVersion && compareVersions(patchVersion, baseVersion) >= 0)
const isCorrect = (patchVersion && compareVersions(patchVersion, baseVersion) >= 0);
console.log(`Is Logic Correct (Should be true): ${isCorrect}`);

if (isCorrect) {
    console.log("SUCCESS: Version comparison now handles equality correctly.");
} else {
    console.log("FAILURE: Logic still fails equality test.");
    process.exit(1);
}

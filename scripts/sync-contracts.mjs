import { readFile, writeFile } from "node:fs/promises";
for (const [name, output] of [
  ["NadWarsSingleZone", "contract"],
  ["NadWarsMatch", "standard"],
]) {
  const a = JSON.parse(
    await readFile(
      new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
  const hex = (x) => (x.startsWith("0x") ? x : `0x${x}`);
  await writeFile(
    new URL(`../src/chain/${output}.json`, import.meta.url),
    JSON.stringify(
      {
        abi: a.abi,
        bytecode: hex(a.bytecode.object),
        runtime: hex(a.deployedBytecode.object),
        immutableReferences: a.deployedBytecode.immutableReferences,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${name}: artifact synchronized`);
}

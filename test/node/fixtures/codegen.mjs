// Exercise one dynamic-codegen entry point per MODE. All are on BERNARD's redline.
const m = process.env.MODE;
let r;
if (m === "eval") r = eval("1+1");
else if (m === "fn") r = (function () {}).constructor("return 3")();
else if (m === "asyncfn") r = await (async () => {}).constructor("return 2")();
else if (m === "gen") r = (function* () {}).constructor("yield 4")().next().value;
console.log("CODEGEN", m, r);

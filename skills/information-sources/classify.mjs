// One yes-or-no question to a classifier model, about images and text, from a script (a routine's --run command has
// no codemode). Uses pi's model layer in Pots' package, with this computer's pi logins.
//
//   node classify.mjs [--model provider/id] [--image shot.png]... [--text "..." | --text-file file] "question"
//
// Prints {"yes": <probability 0 to 1>, "model": "...", "ms": ...}. Exit 3: no classifier model is available here.
// Without --model it takes the first classifier this computer can use that reads images when you give one.
// Images: PNG or JPEG; for typesafe/jev-latest at most 1568 pixels a side.
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const args = process.argv.slice(2);
const images = [];
let modelName, text, question;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--model") modelName = args[++i];
  else if (a === "--image") {
    const file = args[++i];
    const mimeType = /\.jpe?g$/i.test(extname(file)) ? "image/jpeg" : "image/png";
    images.push({ type: "image", data: readFileSync(file).toString("base64"), mimeType });
  } else if (a === "--text") text = args[++i];
  else if (a === "--text-file") text = readFileSync(args[++i], "utf8");
  else question = a;
}
if (!question) {
  console.error('usage: node classify.mjs [--model provider/id] [--image file]... [--text "..." | --text-file file] "question"');
  process.exit(2);
}

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const models = await ModelRuntime.create();
let model;
if (modelName) {
  const [provider, ...id] = modelName.split("/");
  model = await models.getModelOfType("classifier", provider, id.join("/"));
} else {
  const all = await models.getAvailableOfType("classifier");
  model = all.find((m) => !images.length || (m.input ?? []).includes("image"));
}
if (!model) {
  console.error(modelName ? `no classifier ${modelName}` : "no classifier model available here; pi --list-models shows chat models that read images");
  process.exit(3);
}
const started = Date.now();
const result = await models.classify(model, {
  state: text ? { text } : {},
  ...(images.length ? { images } : {}),
  questions: { yes: { type: "bool", instructions: question, criteria: { true: "yes", false: "no" } } },
});
if (result.stopReason !== "stop") {
  console.error(result.errorMessage ?? result.stopReason);
  process.exit(1);
}
console.log(JSON.stringify({ yes: result.answers.yes.probability, model: `${model.provider}/${model.id}`, ms: Date.now() - started }));

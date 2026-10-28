import { type ClassifierAnswer, type ClassifierQuestion, getSupportedThinkingLevels, type JsonObject, type Models } from "@earendil-works/pi-ai";
import type { Judge, JudgeAnswer, JudgeInput } from "../core/judge.ts";
import { requireModel } from "./models.ts";

/** bot.json "judge": the bot's own model, no judge, or a classifier model "provider/modelId". */
export type JudgeSetting = "main" | "off" | (string & {});

/**
 * The judge for events that do not mention the bot, or undefined for "off" (every such event wakes the bot).
 * A classifier ("typesafe/jev-latest", "llama.cpp/Kev-4B-Q4_K_M", ...) answers through pi's classify().
 * "main" asks the bot's own chat model, so no extra account is needed. Models are looked up for each judgment:
 * a judge that is not reachable now (a local server that is down) fails that judgment, and the events go to the bot.
 */
export function createJudge(setting: JudgeSetting, models: Models, mainModel: () => string): Judge | undefined {
  if (setting === "off") return undefined;
  if (setting === "main") return chatJudge(models, mainModel);
  return {
    async judge(input) {
      const classifier = await requireModel(models, setting, (provider, id) => models.getModelOfType("classifier", provider, id));
      const result = await models.classify(classifier, { state: judgeState(input), questions: judgeQuestions(input.name) });
      if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? result.stopReason);
      return { related: probability(result.answers.related), respond: probability(result.answers.respond) };
    },
  };
}

const CHAT_JUDGE_PROMPT = `You judge events in a team chat for one team member. The user message is JSON: "state" has the team member, what they are responsible for, the place, earlier messages and the new events; "questions" has two yes-or-no questions about the new events.
For each question, give the probability from 0 to 1 that the answer is yes. Answer with only this JSON: {"related": <probability>, "respond": <probability>}`;

function chatJudge(models: Models, mainModel: () => string): Judge {
  return {
    async judge(input) {
      const model = await requireModel(models, mainModel(), (provider, id) => models.getModel(provider, id));
      // A short judgment: the lowest thinking level the model has.
      const levels = getSupportedThinkingLevels(model);
      const reasoning = (["minimal", "low"] as const).find((level) => levels.includes(level));
      const content = JSON.stringify({ state: judgeState(input), questions: judgeQuestions(input.name) }, null, 1);
      const reply = await models.completeSimple(
        model,
        { systemPrompt: CHAT_JUDGE_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] },
        reasoning ? { reasoning } : {},
      );
      if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
      const text = reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
      return parseAnswer(text);
    },
  };
}

function judgeState(input: JudgeInput): JsonObject {
  return {
    team_member: input.name,
    what_this_team_member_is_responsible_for: input.responsibilities,
    place: input.place,
    earlier_messages: input.earlier.map((item) => ({ ...item })),
    new_events: input.latest.map((item) => ({ ...item })),
  };
}

function judgeQuestions(name: string): Record<keyof JudgeAnswer, ClassifierQuestion> {
  return {
    related: {
      type: "bool",
      instructions: `Are the new events about something ${name} is responsible for, or addressed to ${name}?`,
      criteria: { true: `About ${name}'s responsibilities, or addressed to ${name}`, false: `Not about ${name}` },
    },
    respond: {
      type: "bool",
      instructions: `Does ${name} need to respond to the new events?`,
      criteria: { true: `${name} should respond`, false: `${name} does not need to respond` },
    },
  };
}

function probability(answer: ClassifierAnswer | undefined): number {
  if (answer?.type !== "bool") throw new Error(`the judge gave no yes-or-no answer: ${JSON.stringify(answer)}`);
  return answer.probability;
}

function parseAnswer(text: string): JudgeAnswer {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  const value = json ? (JSON.parse(json) as Partial<Record<keyof JudgeAnswer, unknown>>) : undefined;
  const valid = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 1;
  if (!value || !valid(value.related) || !valid(value.respond)) throw new Error(`the judge did not answer with two probabilities: ${text.slice(0, 200)}`);
  return { related: value.related, respond: value.respond };
}

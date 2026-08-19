/**
 * campaign-results.ts
 *
 * Assembles the campaign's results from the aggregates.
 *
 * The report is a comparison between three TTS providers over the same
 * script, the same telephony, the same STT and the same model, so the
 * only thing that differs between two rows is the vendor being
 * evaluated. Everything that could quietly break that — a rate with no
 * denominator, a rehearsal counted as a call, an orchestration timing
 * folded into a voice latency — is either prevented here or reported
 * as a warning attached to the report itself.
 *
 * Nothing in this module writes. Building a report cannot change a
 * campaign, and cannot place a call.
 */

import { isDialingEnabled } from "../config/campaign.config";
import { getCampaign } from "../db/repositories/campaign.repo";
import { isSuccessOutcome, type OutcomeType } from "../outcome/outcome-types";
import {
  attemptAggregates,
  classifierCounts,
  contactStatusCounts,
  coverage,
  dispatchAggregates,
  outcomeAggregates,
  voiceAggregates,
} from "./results.repo";
import type {
  CampaignResults,
  ProviderAttemptRow,
  ProviderDispatchRow,
  ProviderOutcomeRow,
  ProviderVoiceRow,
  Rate,
} from "./results-types";

const VOICE_NOTE =
  "Conversation measurements only, from call_metrics — produced by the existing session " +
  "metrics collector and stored verbatim. No dispatcher timing is included in any figure here.";

const ORCHESTRATION_NOTE =
  "Campaign orchestration measurements only, from dispatch_metrics — queueing, dialling and " +
  "persistence. These are the platform's own overhead and are never added to, averaged with, " +
  "or compared against the voice latencies above.";

/** A rate that refuses to exist without a denominator. */
function rate(numerator: number, denominator: number): Rate {
  return {
    value: denominator > 0 ? numerator / denominator : null,
    numerator,
    denominator,
  };
}

export async function buildCampaignResults(campaignId: string): Promise<CampaignResults | undefined> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return undefined;

  const [attempts, outcomes, classifiers, voice, dispatch, contacts, health] = await Promise.all([
    attemptAggregates(campaignId),
    outcomeAggregates(campaignId),
    classifierCounts(campaignId),
    voiceAggregates(campaignId),
    dispatchAggregates(campaignId),
    contactStatusCounts(campaignId),
    coverage(campaignId),
  ]);

  const providers: readonly ProviderAttemptRow[] = attempts.map((row) => ({
    provider: row.provider,
    attempts: row.attempts,
    rehearsedNotDialled: row.rehearsedNotDialled,
    dialled: row.dialled,
    connected: row.connected,
    completed: row.completed,
    noAnswer: row.noAnswer,
    busy: row.busy,
    failed: row.failed,
    connectRate: rate(row.connected, row.dialled),
    connectedSeconds: row.connectedSeconds,
    inferredTerminal: row.inferredTerminal,
  }));

  const connectedByProvider = new Map(providers.map((row) => [row.provider, row.connected]));
  const outcomeRows = buildOutcomeRows(outcomes, connectedByProvider);

  const byOutcomeType: Record<string, number> = {};
  for (const row of outcomes) {
    byOutcomeType[row.outcomeType] = (byOutcomeType[row.outcomeType] ?? 0) + row.count;
  }

  const totals = providers.reduce(
    (sum, row) => ({
      attempts: sum.attempts + row.attempts,
      dialled: sum.dialled + row.dialled,
      connected: sum.connected + row.connected,
      completed: sum.completed + row.completed,
    }),
    { attempts: 0, dialled: 0, connected: 0, completed: 0 },
  );
  const classified = outcomeRows.reduce((sum, row) => sum + row.classified, 0);
  const successes = outcomeRows.reduce((sum, row) => sum + row.successes, 0);

  const voiceRows: readonly ProviderVoiceRow[] = voice.map((row) => ({
    provider: row.provider,
    calls: row.calls,
    sttMs: row.sttMs,
    llmMs: row.llmMs,
    ttsMs: row.ttsMs,
    totalMs: row.totalMs,
    firstTurnTotalMs: row.firstTurnTotalMs,
    turnsPerCall: row.turnsPerCall,
    conversationSeconds: row.conversationSeconds,
    costUsd: {
      total: row.costTotalUsd,
      perCall: row.calls > 0 && row.costTotalUsd !== null ? round6(row.costTotalUsd / row.calls) : null,
      telephony: row.costTelephonyUsd,
      stt: row.costSttUsd,
      llm: row.costLlmUsd,
      tts: row.costTtsUsd,
    },
  }));

  const dispatchRows: readonly ProviderDispatchRow[] = dispatch.map((row) => ({
    provider: row.provider,
    calls: row.calls,
    queueWaitMs: row.queueWaitMs,
    claimToDialMs: row.claimToDialMs,
    dialRequestMs: row.dialRequestMs,
    ringToAnswerMs: row.ringToAnswerMs,
    persistMs: row.persistMs,
    classifyMs: row.classifyMs,
  }));

  const dialingEnabled = isDialingEnabled();

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      type: campaign.campaignType,
      status: campaign.status,
      language: campaign.language,
      telephonyProvider: campaign.telephonyProvider,
      script: `${campaign.scriptId} ${campaign.scriptVersion}`,
      scriptHash: campaign.scriptHash,
      pilotStage: campaign.pilotStage,
      createdAt: campaign.createdAt,
      startedAt: campaign.startedAt,
      completedAt: campaign.completedAt,
    },
    dialing: {
      enabled: dialingEnabled,
      callsPlaced: totals.dialled,
      note: dialingEnabled
        ? "Dialing is ENABLED. Every attempt below that is not a rehearsal reached the telephony provider."
        : "Dialing is DISABLED (CAMPAIGN_DIALING_ENABLED is not true). Any attempt rows are rehearsals " +
          "recorded before the kill switch stopped the call — no telephony provider was contacted.",
    },
    contacts,
    funnel: {
      attempts: totals.attempts,
      dialled: totals.dialled,
      connected: totals.connected,
      completed: totals.completed,
      classified,
      successes,
      connectRate: rate(totals.connected, totals.dialled),
      successRateOfConnected: rate(successes, totals.connected),
    },
    providers,
    outcomes: { perProvider: outcomeRows, byType: byOutcomeType, classifiers },
    voice: { perProvider: voiceRows, note: VOICE_NOTE },
    orchestration: { perProvider: dispatchRows, note: ORCHESTRATION_NOTE },
    dataHealth: {
      attemptsMissingVoiceMetrics: health.missingVoiceMetrics,
      attemptsMissingOutcome: health.missingOutcome,
      inferredTerminalStatuses: health.inferredTerminal,
      warnings: buildWarnings({
        dialingEnabled,
        totals,
        classified,
        health,
        providerCount: providers.length,
      }),
    },
    generatedAt: new Date(),
  };
}

function buildOutcomeRows(
  rows: ReadonlyArray<{ provider: string; outcomeType: string; succeeded: boolean | null; count: number }>,
  connectedByProvider: ReadonlyMap<string, number>,
): readonly ProviderOutcomeRow[] {
  const byProvider = new Map<
    string,
    { classified: number; successes: number; failures: number; undetermined: number; byType: Record<string, number> }
  >();

  for (const row of rows) {
    const entry = byProvider.get(row.provider) ?? {
      classified: 0,
      successes: 0,
      failures: 0,
      undetermined: 0,
      byType: {} as Record<string, number>,
    };
    entry.classified += row.count;
    // `succeeded` is the stored verdict; the outcome type is what the
    // taxonomy calls a success. They are checked against each other
    // rather than one trusted blindly, so a hand-written or
    // back-filled row that disagrees cannot inflate the success count.
    if (row.succeeded === true && isSuccessOutcome(row.outcomeType as OutcomeType)) {
      entry.successes += row.count;
    } else if (row.succeeded === null) {
      entry.undetermined += row.count;
    } else {
      entry.failures += row.count;
    }
    entry.byType[row.outcomeType] = (entry.byType[row.outcomeType] ?? 0) + row.count;
    byProvider.set(row.provider, entry);
  }

  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => ({
      provider,
      classified: entry.classified,
      successes: entry.successes,
      failures: entry.failures,
      undetermined: entry.undetermined,
      successRateOfConnected: rate(entry.successes, connectedByProvider.get(provider) ?? 0),
      byOutcomeType: entry.byType,
    }));
}

/**
 * What the reader needs to know before believing the numbers above.
 *
 * These are not errors. They are the report saying out loud what it
 * cannot support — which is the difference between a small pilot and a
 * small pilot that looks like a result.
 */
function buildWarnings(input: {
  dialingEnabled: boolean;
  totals: { attempts: number; dialled: number; connected: number };
  classified: number;
  health: { missingVoiceMetrics: number; missingOutcome: number; inferredTerminal: number };
  providerCount: number;
}): readonly string[] {
  const warnings: string[] = [];

  if (!input.dialingEnabled) {
    warnings.push(
      "CAMPAIGN_DIALING_ENABLED is not true: no call in this report reached a telephony provider.",
    );
  }
  if (input.totals.connected === 0) {
    warnings.push("No call has connected yet, so every conversation figure is empty rather than zero.");
  } else if (input.totals.connected < 30) {
    warnings.push(
      `Only ${input.totals.connected} connected call(s). Provider differences at this sample size are ` +
        `noise, not findings.`,
    );
  }
  if (input.health.inferredTerminal > 0) {
    warnings.push(
      `${input.health.inferredTerminal} attempt(s) ended in a status this system DEDUCED (a ring timeout), ` +
        `not one the carrier reported. No carrier status callback is wired up yet.`,
    );
  }
  if (input.health.missingVoiceMetrics > 0) {
    warnings.push(
      `${input.health.missingVoiceMetrics} connected call(s) have no voice metrics stored, so they are ` +
        `absent from the latency and cost figures.`,
    );
  }
  if (input.health.missingOutcome > 0) {
    warnings.push(
      `${input.health.missingOutcome} finished call(s) have no outcome classified and are excluded from ` +
        `the success rate.`,
    );
  }
  if (input.providerCount > 0 && input.providerCount < 3) {
    warnings.push(
      `Only ${input.providerCount} provider(s) have attempts. This is not yet a three-way comparison.`,
    );
  }
  return warnings;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

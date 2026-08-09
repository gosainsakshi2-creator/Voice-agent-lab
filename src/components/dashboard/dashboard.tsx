"use client";

import { useMemo, useState } from "react";

import { Header } from "@/components/dashboard/header";
import { ConfigPanel, type ProviderStackFormValue } from "@/components/dashboard/config-panel";
import { TranscriptPanel } from "@/components/dashboard/transcript-panel";
import { InsightsPanel, STACK_CATEGORY_ICONS, STACK_CATEGORY_LABEL } from "@/components/dashboard/insights-panel";
import { useLiveSession } from "@/hooks/use-live-session";
import { LANGUAGE_METADATA } from "@/constants/languages.constants";
import {
  MOCK_LANGUAGE_MODEL_PROVIDERS,
  MOCK_PROVIDER_HEALTH,
  MOCK_SPEECH_TO_TEXT_PROVIDERS,
  MOCK_TELEPHONY_PROVIDERS,
  MOCK_TEXT_TO_SPEECH_PROVIDERS,
} from "@/lib/mock";
import { DEFAULT_PROVIDER_STACK, DEFAULT_SESSION_REQUEST } from "@/lib/mock/mock-session";
import { ProviderCategory, SupportedLanguage } from "@/types/enums";
import type { ProviderDescriptor } from "@/types/provider.types";

function findDescriptor(
  category: ProviderCategory,
  id: string,
  live: import("@/hooks/use-live-session").ProviderCatalog | undefined,
): ProviderDescriptor {
  const liveLookup = live
    ? {
        [ProviderCategory.TELEPHONY]: live.telephony,
        [ProviderCategory.SPEECH_TO_TEXT]: live.speechToText,
        [ProviderCategory.LANGUAGE_MODEL]: live.languageModel,
        [ProviderCategory.TEXT_TO_SPEECH]: live.textToSpeech,
      }[category]
    : undefined;
  const mockLookup = {
    [ProviderCategory.TELEPHONY]: MOCK_TELEPHONY_PROVIDERS,
    [ProviderCategory.SPEECH_TO_TEXT]: MOCK_SPEECH_TO_TEXT_PROVIDERS,
    [ProviderCategory.LANGUAGE_MODEL]: MOCK_LANGUAGE_MODEL_PROVIDERS,
    [ProviderCategory.TEXT_TO_SPEECH]: MOCK_TEXT_TO_SPEECH_PROVIDERS,
  }[category];

  return (
    liveLookup?.find((d) => d.id === id) ??
    mockLookup.find((d) => d.id === id) ??
    liveLookup?.[0] ??
    mockLookup[0]!
  );
}

export function Dashboard() {
  const [stack, setStack] = useState<ProviderStackFormValue>({
    telephonyId: DEFAULT_PROVIDER_STACK.telephony.id,
    speechToTextId: DEFAULT_PROVIDER_STACK.speechToText.id,
    languageModelId: DEFAULT_PROVIDER_STACK.languageModel.id,
    textToSpeechId: DEFAULT_PROVIDER_STACK.textToSpeech.id,
  });
  const [language, setLanguage] = useState<SupportedLanguage>(DEFAULT_SESSION_REQUEST.language);
  const [destinationNumber, setDestinationNumber] = useState(
    DEFAULT_SESSION_REQUEST.destinationNumber ?? "",
  );
  
  const {
    sessionState,
    transcript,
    callDurationSeconds,
    isCallActive,
    startCall,
    endCall,
    metrics,
    health,
    providers,
    errorMessage,
  } = useLiveSession(stack, language, destinationNumber);
  
  const stackEntries = useMemo(
    () => [
      {
        categoryLabel: STACK_CATEGORY_LABEL[ProviderCategory.TELEPHONY],
        icon: STACK_CATEGORY_ICONS[ProviderCategory.TELEPHONY],
        descriptor: findDescriptor(ProviderCategory.TELEPHONY, stack.telephonyId, providers),
      },
      {
        categoryLabel: STACK_CATEGORY_LABEL[ProviderCategory.SPEECH_TO_TEXT],
        icon: STACK_CATEGORY_ICONS[ProviderCategory.SPEECH_TO_TEXT],
        descriptor: findDescriptor(ProviderCategory.SPEECH_TO_TEXT, stack.speechToTextId, providers),
      },
      {
        categoryLabel: STACK_CATEGORY_LABEL[ProviderCategory.LANGUAGE_MODEL],
        icon: STACK_CATEGORY_ICONS[ProviderCategory.LANGUAGE_MODEL],
        descriptor: findDescriptor(ProviderCategory.LANGUAGE_MODEL, stack.languageModelId, providers),
      },
      {
        categoryLabel: STACK_CATEGORY_LABEL[ProviderCategory.TEXT_TO_SPEECH],
        icon: STACK_CATEGORY_ICONS[ProviderCategory.TEXT_TO_SPEECH],
        descriptor: findDescriptor(ProviderCategory.TEXT_TO_SPEECH, stack.textToSpeechId, providers),
      },
    ],
    [stack, providers],
  );

  const currentTestLabel = useMemo(() => {
    const names = stackEntries.map((entry) => entry.descriptor.displayName);
    return [...names, LANGUAGE_METADATA[language].label].join(" • ");
  }, [stackEntries, language]);

  const effectiveHealth = health.length > 0 ? health : MOCK_PROVIDER_HEALTH;
  // Benchmark metrics are ALWAYS the real ones. There used to be a
  // fallback to a mock BenchmarkMetrics here whenever no turn had been
  // recorded, which meant a call that completed zero turns rendered
  // invented latencies and cost that were visually indistinguishable
  // from measured ones. An empty metrics object renders as N/A, which
  // is the honest answer.
  const isSystemHealthy = effectiveHealth.every((h) => h.isHealthy);
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background">
      <Header isSystemHealthy={isSystemHealthy} />
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-y-auto p-6 lg:grid-cols-[292px_minmax(0,1fr)_324px] lg:overflow-hidden">
        <div className="lg:min-h-0 lg:overflow-y-auto">
          <ConfigPanel
            stack={stack}
            onStackChange={setStack}
            language={language}
            onLanguageChange={setLanguage}
            destinationNumber={destinationNumber}
            onDestinationNumberChange={setDestinationNumber}
            sessionState={sessionState}
            onStartCall={startCall}
            onEndCall={endCall}
            {...(providers !== undefined ? { providerOptions: providers } : {})}
          />
        </div>

        <div className="min-h-[480px] lg:min-h-0">
          <TranscriptPanel
            currentTestLabel={currentTestLabel}
            sessionState={sessionState}
            transcript={transcript}
          />
          {errorMessage ? (
            <p className="mt-2 text-[12px] text-danger" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </div>

        <div className="lg:min-h-0 lg:overflow-y-auto">
          <InsightsPanel
            stackEntries={stackEntries}
            health={effectiveHealth}
            metrics={metrics}
            liveCallDurationSeconds={callDurationSeconds}
            isCallActive={isCallActive}
          />
        </div>
      </main>
    </div>
  );
}

import { Phone, PhoneOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ProviderSelectField } from "@/components/dashboard/provider-select-field";
import { ACTIVE_SESSION_STATES } from "@/constants/session-states.constants";
import { LANGUAGE_METADATA } from "@/constants/languages.constants";
import {
  MOCK_LANGUAGE_MODEL_PROVIDERS,
  MOCK_SPEECH_TO_TEXT_PROVIDERS,
  MOCK_TELEPHONY_PROVIDERS,
  MOCK_TEXT_TO_SPEECH_PROVIDERS,
} from "@/lib/mock/mock-providers";
import { SessionState, SupportedLanguage } from "@/types/enums";

export interface ProviderStackFormValue {
  readonly telephonyId: string;
  readonly speechToTextId: string;
  readonly languageModelId: string;
  readonly textToSpeechId: string;
}

interface ConfigPanelProps {
  readonly stack: ProviderStackFormValue;
  readonly onStackChange: (next: ProviderStackFormValue) => void;
  readonly language: SupportedLanguage;
  readonly onLanguageChange: (language: SupportedLanguage) => void;
  readonly destinationNumber: string;
  readonly onDestinationNumberChange: (value: string) => void;
  readonly sessionState: SessionState;
  readonly onStartCall: () => void;
  readonly onEndCall: () => void;
  /**
   * Optional live provider catalog (from `/api/providers`, i.e. the
   * real `ProviderRegistry`). When omitted, falls back to the
   * original MOCK_* lists exactly as before — additive-only, no
   * existing caller or behavior changes.
   */
  readonly providerOptions?: {
    readonly telephony: readonly (typeof MOCK_TELEPHONY_PROVIDERS)[number][];
    readonly speechToText: readonly (typeof MOCK_SPEECH_TO_TEXT_PROVIDERS)[number][];
    readonly languageModel: readonly (typeof MOCK_LANGUAGE_MODEL_PROVIDERS)[number][];
    readonly textToSpeech: readonly (typeof MOCK_TEXT_TO_SPEECH_PROVIDERS)[number][];
  };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-subtle-foreground">
      {children}
    </p>
  );
}

export function ConfigPanel({
  stack,
  onStackChange,
  language,
  onLanguageChange,
  destinationNumber,
  onDestinationNumberChange,
  sessionState,
  onStartCall,
  onEndCall,
  providerOptions,
}: ConfigPanelProps) {
  const isCallActive = ACTIVE_SESSION_STATES.includes(sessionState);
 
  const telephonyOptions = providerOptions?.telephony ?? MOCK_TELEPHONY_PROVIDERS;
  const speechToTextOptions = providerOptions?.speechToText ?? MOCK_SPEECH_TO_TEXT_PROVIDERS;
  const languageModelOptions = providerOptions?.languageModel ?? MOCK_LANGUAGE_MODEL_PROVIDERS;
  const textToSpeechOptions = providerOptions?.textToSpeech ?? MOCK_TEXT_TO_SPEECH_PROVIDERS;
  const isBusy =
    sessionState === SessionState.INITIALIZING ||
    sessionState === SessionState.WARMING_PROVIDERS ||
    sessionState === SessionState.ENDING;
  const canStart = sessionState === SessionState.IDLE && destinationNumber.trim().length > 0;
  const canEnd = isCallActive || sessionState === SessionState.READY;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Benchmark Configuration</CardTitle>
        <CardDescription>Select the stack to test, then start the call</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-3.5">
          <SectionLabel>Provider Stack</SectionLabel>
          <div className="flex flex-col gap-3">
            <ProviderSelectField
              label="Telephony"
              value={stack.telephonyId}
              options={telephonyOptions}
              onChange={(id) => onStackChange({ ...stack, telephonyId: id })}
              disabled={isCallActive || isBusy}
            />
            <ProviderSelectField
              label="Speech-to-Text"
              value={stack.speechToTextId}
              options={speechToTextOptions}
              onChange={(id) => onStackChange({ ...stack, speechToTextId: id })}
              disabled={isCallActive || isBusy}
            />
            <ProviderSelectField
              label="Language Model"
              value={stack.languageModelId}
              options={languageModelOptions}
              onChange={(id) => onStackChange({ ...stack, languageModelId: id })}
              disabled={isCallActive || isBusy}
            />
            <ProviderSelectField
              label="Voice (TTS)"
              value={stack.textToSpeechId}
              options={textToSpeechOptions}
              onChange={(id) => onStackChange({ ...stack, textToSpeechId: id })}
              disabled={isCallActive || isBusy}
            />
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-3.5">
          <SectionLabel>Call Setup</SectionLabel>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Conversation Language</Label>
              <Select
                value={language}
                onValueChange={(v) => onLanguageChange(v as SupportedLanguage)}
                disabled={isCallActive || isBusy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                {[
  SupportedLanguage.ENGLISH,
  SupportedLanguage.HINDI,
].map((code) => (
  <SelectItem key={code} value={code}>
    {LANGUAGE_METADATA[code].label}
    <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
      {LANGUAGE_METADATA[code].bcp47Tag}
    </span>
  </SelectItem>
))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="destination-number">Destination Number</Label>
              <Input
                id="destination-number"
                inputMode="tel"
                placeholder="+91 98765 43210"
                value={destinationNumber}
                onChange={(e) => onDestinationNumberChange(e.target.value)}
                disabled={isCallActive || isBusy}
                className="font-mono"
              />
            </div>
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Button onClick={onStartCall} disabled={!canStart || isBusy} size="lg" className="w-full">
            <Phone />
            Start Call
          </Button>
          <Button
            onClick={onEndCall}
            disabled={!canEnd || sessionState === SessionState.ENDING}
            variant="outline"
            className="w-full"
          >
            <PhoneOff />
            End Call
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

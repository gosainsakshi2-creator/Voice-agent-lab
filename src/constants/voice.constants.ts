export type VoiceGender = "male" | "female";

export const TTS_VOICE_METADATA = new Map<string, VoiceGender>([
  ["elevenlabs", "female"],
  ["cartesia", "female"],
  ["sarvam", "male"],
  ["smallest-ai", "female"],
]);
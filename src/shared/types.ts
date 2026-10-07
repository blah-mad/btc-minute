import type { components } from './api.generated.js';

export type Quote = components['schemas']['Quote'];
export type Guess = components['schemas']['Guess'];
export type Direction = Guess['direction'];
export type PlayerState = components['schemas']['PlayerState'];
export type ApiError = components['responses']['Error']['content']['application/json'];

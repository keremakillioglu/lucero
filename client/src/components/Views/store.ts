import type { ViewConfig } from './data';
import { atomWithLocalStorage } from '~/store/utils';

export const viewsState = atomWithLocalStorage<ViewConfig[]>('mcp-views:v1', []);

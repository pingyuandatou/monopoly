import boardFile from '../../data/board.json';
import settingsFile from '../../data/settings.json';
import type { Settings, Square } from './types';

export const SETTINGS = settingsFile as Settings;
export const SQUARES = boardFile.squares as Square[];
export const BOARD_SIZE = SQUARES.length;

if (BOARD_SIZE !== 40) {
  throw new Error(`棋盘应有 40 格，实际 ${BOARD_SIZE}`);
}

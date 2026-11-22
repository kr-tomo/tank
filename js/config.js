// Game constants. Units are px at the base resolution: a half cell is U, a tile is 2U, a unit body is 2 tiles... no: a unit is one tile (32px).
export const U = 16;            // half cell (the grid bricks break on)
export const TILE = 2 * U;      // map tile and unit body size
export const UNIT = TILE;
export const SHOT = 8;          // projectile size

// mode → map size in tiles, enemy spawn tiles, player start tiles
export const MODES = {
  coop:   { tiles: [13, 13], spawns: [[0, 0], [6, 0], [12, 0]], starts: [[4, 12], [8, 12]] },
  versus: { tiles: [19, 13], spawns: [[9, 0], [9, 12]], starts: [[2, 6], [16, 6]] }
};
export const FORTRESS_TILES = 1;  // ring of tiles around the base where theme specials are off

// enemies move at 0.8× the original pace (difficulty tuning)
export const SPEED = { p1: 110, p2: 110, basic: 64, fast: 128, power: 88, armor: 64 };
export const BULLET = { normal: 320, fast: 480 };
export const ENEMY_HP = { basic: 1, fast: 1, power: 1, armor: 4 };
export const ENEMY_TYPES = ['basic', 'fast', 'power', 'armor'];
export const SCORE = { basic: 100, fast: 200, power: 300, armor: 400 };
export const ITEM_IDS = ['grenade', 'helmet', 'clock', 'shovel', 'star', 'tank'];
export const ITEM_TIME = { helmet: 10, clock: 10, shovel: 20, item: 20 };
export const LIVES = 3;
export const MAX_LEVEL = 3;
export const MAX_ENEMIES = 4;
export const SPAWN_INTERVAL = 3;
export const SPAWN_TIME = 1;          // star animation; the enemy is invulnerable and still
export const RESPAWN_TIME = 2;
export const RESPAWN_SHIELD = 2;
export const STAGE_ENEMIES = 20;
export const FLASH_INDEX = [3, 10, 17];  // which enemies (0-based) drop an item
export const STUN_TIME = 1;           // friendly fire (3 hits inside one stun destroy the tank)
export const CLEAR_DELAY = 2;
export const ICE_SLIDE = { slide: 0.15, inertia: 0.3, mud: 0 };
export const MUD_SPEED = 0.6;
export const VERSUS_TIMES = [0, 120, 180, 300];
export const VERSUS_ITEM_INTERVAL = 15;

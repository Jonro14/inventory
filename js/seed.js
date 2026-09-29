// Default layout of the house, loaded from Settings (or the welcome screen).
// Everything here can be changed afterwards inside the app ("Edit layout").
//
// Each closet is a grid (rows x columns). Every shelf has a name that can be edited
// in the app. A "blocked" space (e.g. hanging jackets) is drawn but nothing can be
// stored in it.
//
// Sizes from closet_storage_inventory.md: all cavities are 40 cm wide and 50 cm deep.
// Storage closet heights 6 x 33, 5 x 30, 9 x 20 cm; bedroom closet 7 x 33, 2 x 40 cm.
// Which cavity has which height is a first guess: fix it with "Edit layout".

const FIRST = 'First floor';
const SECOND = 'Second floor';
const HANGING = 'Hanging jackets';

// A shelf: [row, col, extra fields]. Shelves are named "<base> 1", "<base> 2"... in the
// order they are listed, unless they have their own name.
const S = (row, col, x = {}) => ({ row, col, ...x });
const BLOCK = (row, col, rowSpan = 1, colSpan = 1) => ({ row, col, rowSpan, colSpan, blocked: true, name: HANGING });

// One column of n shelves, top to bottom.
const column = (n, col = 1, x = {}) => Array.from({ length: n }, (_, i) => S(i + 1, col, x));

const bathroomCloset = room => ({
  floor: room === 'Bathroom 1' ? FIRST : SECOND, room, name: 'Bathroom closet', cols: 1, rows: 2,
  slots: column(2),
});

const LAYOUT = [
  // ---------------- first floor
  {
    floor: FIRST, room: 'Storage room', name: 'Storage closet', cols: 4, rows: 5, w: 40, d: 50,
    note: 'Almacén. Columns 3-4, rows 2-4 hold hanging jackets (not listed).',
    slots: [
      S(1, 1, { h: 33 }), S(1, 2, { h: 33 }), S(1, 3, { h: 33 }), S(1, 4, { h: 33 }),
      S(2, 1, { h: 33 }), S(2, 2, { h: 33 }), BLOCK(2, 3, 3, 2),
      S(3, 1, { h: 30 }), S(3, 2, { h: 30 }),
      S(4, 1, { h: 30 }), S(4, 2, { h: 30 }),
      S(5, 1, { h: 20 }), S(5, 2, { h: 20 }), S(5, 3, { h: 20 }), S(5, 4, { h: 20 }),
    ],
  },
  { floor: FIRST, room: 'Storage room', name: 'Extras', cols: 1, rows: 1, slots: [S(1, 1, { name: 'Extras' })] },
  bathroomCloset('Bathroom 1'),
  {
    floor: FIRST, room: 'Bedroom', name: 'Bedroom closet', cols: 2, rows: 5, w: 40, d: 50,
    note: 'Habitación. Left column 5 shelves; right column 1 up, 1 down and hanging jackets in rows 2-4 (not listed).',
    slots: [
      ...column(5, 1, { h: 33 }),
      S(1, 2, { h: 40 }), BLOCK(2, 2, 3, 1), S(5, 2, { h: 40 }),
    ],
  },
  { floor: FIRST, room: 'Hall', name: 'Memories box', cols: 1, rows: 1, note: 'Big plastic box.', slots: [S(1, 1, { name: 'Memories box' })] },

  // ---------------- second floor
  { floor: SECOND, room: 'Hall', name: 'Vertical drawers', cols: 1, rows: 4, base: 'Drawer', note: 'Sizes to be measured.', slots: column(4) },
  { floor: SECOND, room: 'Bedroom', name: 'Walk-in room', cols: 3, rows: 4, slots: [], note: 'Empty for now. Tap "Edit layout" and the + cells to add shelves.' },
  { floor: SECOND, room: 'Master bedroom', name: 'Closet', cols: 2, rows: 4, slots: [...column(4, 1), ...column(4, 2)] },
  { floor: SECOND, room: 'Master bedroom', name: 'Walk-in room', cols: 3, rows: 4, slots: [], note: 'Empty for now. Tap "Edit layout" and the + cells to add shelves.' },
  bathroomCloset('Master bathroom'),
  bathroomCloset('Shower'),
  { floor: SECOND, room: 'Terrace', name: 'Storage', cols: 2, rows: 2, slots: [], note: 'Empty for now. Tap "Edit layout" and the + cells to add shelves.' },
];

// Returns the batch operations that create all units and slots.
export function buildSeed(newId, startOrder = 0) {
  const ops = [];
  LAYOUT.forEach((u, i) => {
    const unitId = newId();
    ops.push({
      op: 'set', coll: 'units', id: unitId,
      data: { name: u.name, floor: u.floor, room: u.room, cols: u.cols, rows: u.rows, order: startOrder + i, note: u.note || '' },
    });
    let n = 0;
    for (const s of u.slots) {
      ops.push({
        op: 'set', coll: 'slots', id: newId(),
        data: {
          unitId,
          name: s.name || `${u.base || 'Shelf'} ${++n}`,
          blocked: !!s.blocked,
          row: s.row,
          col: s.col,
          rowSpan: s.rowSpan || 1,
          colSpan: s.colSpan || 1,
          h: s.blocked ? null : (s.h ?? null),
          w: s.blocked ? null : (u.w ?? null),
          d: s.blocked ? null : (u.d ?? null),
          note: '',
        },
      });
    }
  });
  return ops;
}

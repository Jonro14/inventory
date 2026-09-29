// Default layout of the house, loaded once from Settings (or the welcome screen).
// Everything here can be changed afterwards inside the app ("Edit layout").
//
// Known data comes from closet_storage_inventory.md:
//   Storage closet (Almacén): 20 cavities, 40 x 50 cm, heights 6 x 33, 5 x 30, 9 x 20 cm
//   Bedroom closet (Habitación): 9 cavities, 40 x 50 cm, heights 7 x 33, 2 x 40 cm
// The row/column arrangement of the cavities is NOT known yet: the grids below are
// placeholders to be rearranged with "Edit layout".
//
// Tag scheme (what is written on the physical label):
//   A1..A20      Storage closet (Almacén)
//   H1..H9       Bedroom closet (Habitación)
//   D1..D4       Vertical drawers
//   B1L1..B1L4   Bathroom 1, left closet, shelf 1..4 (B1R = right closet; B2.., B3..)
//   W1..         Walk-in room, master bedroom (empty: add shelves when built)
//   K1..         Walk-in room, kids bedroom (empty)
//   M1           Memories box, living room

const LAYOUT = [
  {
    name: 'Storage closet', room: 'Storage room', prefix: 'A', cols: 4, rows: 5,
    w: 40, d: 50, heights: [33, 33, 33, 33, 33, 33, 30, 30, 30, 30, 30, 20, 20, 20, 20, 20, 20, 20, 20, 20],
    note: 'Almacén. Placeholder grid: rearrange with "Edit layout" to match the real closet.',
  },
  {
    name: 'Bedroom closet', room: 'Master bedroom', prefix: 'H', cols: 3, rows: 3,
    w: 40, d: 50, heights: [40, 40, 33, 33, 33, 33, 33, 33, 33],
    note: 'Habitación. Placeholder grid: rearrange with "Edit layout" to match the real closet.',
  },
  {
    name: 'Walk-in room', room: 'Master bedroom', prefix: 'W', cols: 3, rows: 4, count: 0,
    note: 'Empty for now. Tap "Edit layout" and the + cells to add shelves.',
  },
  {
    name: 'Walk-in room', room: 'Kids bedroom', prefix: 'K', cols: 3, rows: 4, count: 0,
    note: 'Empty for now. Tap "Edit layout" and the + cells to add shelves.',
  },
  {
    name: 'Vertical drawers', room: 'Other', prefix: 'D', cols: 1, rows: 4, count: 4,
    note: 'Sizes to be measured. Set the room with "Edit layout".',
  },
  ...[1, 2, 3].flatMap(b => [
    { name: 'Left closet', room: `Bathroom ${b}`, prefix: `B${b}L`, cols: 1, rows: 4, count: 4, note: 'Number of shelves to be checked.' },
    { name: 'Right closet', room: `Bathroom ${b}`, prefix: `B${b}R`, cols: 1, rows: 4, count: 4, note: 'Number of shelves to be checked.' },
  ]),
  {
    name: 'Memories box', room: 'Living room', prefix: 'M', cols: 1, rows: 1, count: 1,
    labels: ['Memories'], note: 'Big plastic box.',
  },
];

// Returns the batch operations that create all units and slots.
export function buildSeed(newId, startOrder = 0) {
  const ops = [];
  LAYOUT.forEach((u, i) => {
    const unitId = newId();
    ops.push({
      op: 'set', coll: 'units', id: unitId,
      data: { name: u.name, room: u.room, prefix: u.prefix, cols: u.cols, rows: u.rows, order: startOrder + i, note: u.note || '' },
    });
    const count = u.count ?? u.heights.length;
    for (let n = 0; n < count; n++) {
      ops.push({
        op: 'set', coll: 'slots', id: newId(),
        data: {
          unitId,
          tag: `${u.prefix}${n + 1}`,
          label: (u.labels && u.labels[n]) || '',
          row: Math.floor(n / u.cols) + 1,
          col: (n % u.cols) + 1,
          rowSpan: 1,
          colSpan: 1,
          h: u.heights ? u.heights[n] : null,
          w: u.w ?? null,
          d: u.d ?? null,
          note: '',
        },
      });
    }
  });
  return ops;
}

'use strict';

/** Test fallback kits. Live boot loads `content/` via pack.templates. */
const TEMPLATES = Object.freeze({
    rat: Object.freeze({
        id: 'rat',
        label: 'Cave Rat',
        hp: 30,
        hpMax: 30,
        armor: 1,
        mitigation: 0.1,
        maxBlock: 0,
        canBlock: false,
        exp: 10,
        aggro: true,
        resists: Object.freeze({ physical: 0 }),
        speed: 100,
        flags: Object.freeze({
            targetDistance: 1,
            aggroRange: 7,
            loseTargetDistance: 12,
            pushable: true,
            canPushCreatures: false
        }),
        attacks: Object.freeze([
            Object.freeze({
                id: 'melee_0',
                kind: 'melee',
                intervalMs: 2000,
                chance: 100,
                range: 1,
                element: 'physical',
                min: 0,
                max: 26
            })
        ]),
        loot: Object.freeze([
            Object.freeze({ id: 'gold_coin', name: 'Gold Coin', chance: 85000, maxCount: 2 }),
            Object.freeze({ id: 'cookie', name: 'Cookie', chance: 750 }),
            Object.freeze({ id: 'cheese', name: 'Cheese', chance: 30000 })
        ])
    }),
    dummy: Object.freeze({
        id: 'dummy',
        label: 'Dummy',
        hp: 20,
        hpMax: 20,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        canBlock: false,
        exp: 5,
        aggro: false,
        resists: Object.freeze({ physical: 0 }),
        speed: 0,
        flags: Object.freeze({
            targetDistance: 1,
            aggroRange: 0,
            loseTargetDistance: 12,
            pushable: false,
            canPushCreatures: false
        }),
        attacks: Object.freeze([
            Object.freeze({
                id: 'melee_0',
                kind: 'melee',
                intervalMs: 2000,
                chance: 100,
                range: 1,
                element: 'physical',
                min: 0,
                max: 0
            })
        ]),
        loot: Object.freeze([
            Object.freeze({ id: 'gold_coin', name: 'Gold Coin', chance: 100000, maxCount: 1 })
        ])
    }),
    guide: Object.freeze({
        id: 'guide',
        label: 'Guide',
        isNpc: true,
        attackableNpc: false,
        hp: 100,
        hpMax: 100,
        armor: 0,
        mitigation: 1,
        maxBlock: 0,
        canBlock: false,
        exp: 0,
        aggro: false,
        resists: Object.freeze({ physical: 0 }),
        flags: Object.freeze({
            targetDistance: 1,
            aggroRange: 0,
            loseTargetDistance: 12
        }),
        attacks: Object.freeze([]),
        loot: Object.freeze([]),
        dialog: Object.freeze({
            start: 'start',
            nodes: Object.freeze({
                start: Object.freeze({
                    text: 'Welcome, hunter. Need supplies or a job?',
                    replies: Object.freeze([
                        Object.freeze({ label: 'Trade', action: 'open_shop' }),
                        Object.freeze({
                            label: 'Job',
                            goto: 'job',
                            set: Object.freeze({ 'guide.mission': 1 })
                        }),
                        Object.freeze({ label: 'Bye', action: 'close' })
                    ])
                }),
                job: Object.freeze({
                    text: 'Rats drop cheese. Bring me one and I will pay you.',
                    replies: Object.freeze([
                        Object.freeze({
                            label: 'I have the cheese',
                            action: 'take_item',
                            item: 'cheese',
                            count: 1,
                            give: Object.freeze({ item: 'gold_coin', count: 5 }),
                            set: Object.freeze({ 'guide.mission': 2 }),
                            goto: 'done',
                            when: Object.freeze([
                                Object.freeze({ item: 'cheese', min: 1 }),
                                Object.freeze({ storage: 'guide.mission', max: 1 })
                            ])
                        }),
                        Object.freeze({ label: 'I will look around', action: 'close' })
                    ])
                }),
                done: Object.freeze({
                    text: 'That is the stuff. Come back if you need supplies.',
                    replies: Object.freeze([
                        Object.freeze({ label: 'Thanks', action: 'close' })
                    ])
                })
            })
        }),
        shop: Object.freeze({
            currency: 'gold_coin',
            items: Object.freeze([
                Object.freeze({ item: 'cookie', buy: 2, sell: 1 }),
                Object.freeze({ item: 'cheese', buy: 4, sell: 1 }),
                Object.freeze({
                    item: 'torch',
                    buy: 8,
                    sell: 0,
                    when: Object.freeze({ storage: 'guide.mission', min: 1 })
                })
            ])
        })
    })
});

function getTemplate(kind, catalog) {
    const key = String(kind || '').toLowerCase();
    if (catalog && catalog[key]) return catalog[key];
    return TEMPLATES[key] || null;
}

module.exports = { TEMPLATES, getTemplate };

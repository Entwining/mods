import { describe, expect, test } from 'claude-code/testing';
import { selectWords } from '../hooks/select.ts';
import { addTurn, NO_WORDS } from '../hooks/words.ts';

const words = (...turns: string[]) => turns.reduce(addTurn, NO_WORDS);
// Messages as long as the plain ones, so one can stand in only for another.
// The first message and eight of them fill the view exactly, leaving no room
// for a note of the messages left out.
const long = (text: string) => text.padEnd(2999, '.');
const plain = (i: number) => long(`${i}`);
const call = (tool: string, input: Record<string, unknown>) => `${tool} ${JSON.stringify(input)}`;
const MAKE = call('Bash', { command: 'make' });

describe('selectWords', () => {
  test('a long conversation keeps its first and newest messages, then those that set a limit, and stays within the view', () => {
    const turns = [
      'the task',
      long('do not push to main'),
      long('先别动生产数据库'),
      ...Array.from({ length: 18 }, (_, i) => plain(i)),
    ];
    const view = selectWords(words(...turns), MAKE);
    expect(view.slice(0, 4)).toEqual([...turns.slice(0, 3), '[13 messages left out]']);
    expect(view.slice(4)).toEqual(turns.slice(-5));
    expect(view.join('').length).toBeLessThanOrEqual(24_000);
  });

  test('a message that rules something out is read before newer ones that only narrow what the agent may do', () => {
    const narrowing = [
      'only run the unit suite',
      'run it without network',
      'skip lint unless formatting changed',
      'check all packages except docs',
      'stop the mock server after',
      'avoid rebuilding unchanged targets',
      'not the docs yet',
      'no snapshots',
    ];
    const turns = [
      'the task',
      long('never touch the billing tables'),
      ...narrowing.map(long),
      'go',
    ];
    expect(selectWords(words(...turns), MAKE)).toContain(turns[1]);
  });

  test('a Chinese word that only holds a limit word, such as 区别, sets no limit', () => {
    const compounds = [
      '看一下这两个模块有什么区别',
      '把日志级别改成调试',
      '这个接口的格式比较特别',
      '按错误类别拆开测试',
      '自动识别文件编码',
      '单元测试和集成测试分别跑',
      '这里不仅要改类型',
      '别人的分支先合进来',
    ];
    const turns = ['整理仓库', long('先别动生产数据库'), ...compounds.map(long), '继续'];
    expect(selectWords(words(...turns), MAKE)).toContain(turns[1]);
  });

  test('a message that names what the call touches is read before newer ones that do not', () => {
    for (const [message, input] of [
      ['the seed data in db/migrations is hand-written', { command: 'rm -rf db/migrations' }],
      ['the release script is hand-tuned', { command: 'cd app\nrelease' }],
      ['the billing module is frozen', { command: 'rm src/billing.ts' }],
    ] as const) {
      const turns = ['the task', long(message), ...Array.from({ length: 20 }, (_, i) => plain(i))];
      expect(selectWords(words(...turns), call('Bash', input))[1]).toBe(turns[1]);
    }
  });

  test('a word few messages hold counts for more than words most of them share with the call', () => {
    const rates = Array.from({ length: 20 }, (_, i) => long(`${i} the new rate`));
    const turns = ['the task', long('billing.ts is frozen this week'), ...rates];
    const edit = call('Edit', {
      file_path: '/w/src/billing.ts',
      old_string: 'the rate',
      new_string: 'the new rate',
    });
    expect(selectWords(words(...turns), edit)).toContain(turns[1]);
  });

  test('messages the store let go are counted with those the view leaves out', () => {
    const conversation = words('the task', ...Array.from({ length: 30 }, (_, i) => plain(i)));
    expect(conversation.leftOut).toBe(9);
    expect(selectWords(conversation, MAKE)[1]).toBe('[23 messages left out]');
  });

  test('a long message keeps its head, its tail, and what between sets a limit or names what the call touches, within its share', () => {
    const filler = 'Some context about the build. '.repeat(150);
    const limits = 'Never run it. Some context. '.repeat(400);
    for (const [message, kept] of [
      [`HEAD ${filler}Never run the deploy script. ${filler}TAIL`, 'Never run the deploy script.'],
      [`HEAD ${limits}TAIL`, 'Never run it.'],
      [`HEAD ${filler}The seeds in db/migrations are hand-written. ${filler}TAIL`, 'db/migrations'],
      [`HEAD ${filler}Never publish ${'the build '.repeat(250)}${filler}TAIL`, 'Never publish'],
    ] as const) {
      const [view] = selectWords(words(message), call('Bash', { command: 'rm -rf db/migrations' }));
      expect(view).toMatch(/^HEAD/);
      expect(view).toMatch(/TAIL$/);
      expect(view).toContain(kept);
      expect(view).toContain('characters left out');
      expect(view!.length).toBeLessThanOrEqual(4000);
    }
  });
});

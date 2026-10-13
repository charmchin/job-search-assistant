import { describe, expect, it, vi } from 'vitest';
import {
  AI_RESPONSE_MAX_BYTES,
  extractionSchema,
  readAiContent,
  validateAiExtraction,
  type Extraction,
} from '@/lib/extraction';

const text =
  '星河科技｜研发岗\n工作地点：上海\n网申截止：2026-12-20\n请准备简历';
const fallback: Extraction = {
  organization: '星河科技',
  role: '研发岗',
  direction: '',
  location: '上海',
  sourceName: '粘贴文本',
  sourceUrl: '',
  description: text,
  priority: 'medium',
  deadline: null,
  tags: [],
  specialNotes: '',
  decision: 'undecided',
  fitScore: 0,
  interestScore: 0,
  nextAction: '核对岗位',
  nextActionAt: null,
  highlights: [],
  risks: [],
  requirements: [{ name: '简历' }],
  tasks: [
    { title: '检查材料', dueAt: null, estimatedMinutes: 30, source: 'rule' },
  ],
  evidence: { organization: '星河科技' },
  confidence: 0.55,
};
const validate = (input: unknown) =>
  validateAiExtraction(input, fallback, text, 'https://jobs.example.com/1');

describe('AI 草稿运行时校验', () => {
  it.each([
    ['顶层 null', null],
    ['顶层数组', []],
    ['顶层文本', 'hello'],
    ['空对象', {}],
    ['错误任务数组', { role: '研发岗', tasks: 'wrong-type' }],
    ['空亮点', { role: '研发岗', highlights: null }],
    ['空材料', { role: '研发岗', requirements: null }],
    ['错误材料名', { role: '研发岗', requirements: [{ name: 3 }] }],
    [
      '空任务标题',
      {
        role: '研发岗',
        tasks: [{ title: '', dueAt: null, source: 'ai', estimatedMinutes: 30 }],
      },
    ],
    ['错误时间', { role: '研发岗', deadline: 'invalid-date' }],
    ['上溢置信度', { role: '研发岗', confidence: 10 }],
    ['下溢置信度', { role: '研发岗', confidence: -1 }],
    ['文本置信度', { role: '研发岗', confidence: '0.8' }],
    ['无穷置信度', { role: '研发岗', confidence: Infinity }],
    ['非数置信度', { role: '研发岗', confidence: NaN }],
    ['错误优先级', { role: '研发岗', priority: 'urgent' }],
    ['公司类型错误', { organization: {} }],
    ['超长正文', { role: '研发岗', description: 'a'.repeat(8001) }],
    ['超长岗位', { role: 'a'.repeat(301) }],
    ['超长依据', { role: '研发岗', evidence: { role: 'a'.repeat(601) } }],
    [
      '过多依据',
      {
        role: '研发岗',
        evidence: Object.fromEntries(
          Array.from({ length: 61 }, (_, i) => [String(i), '研发岗']),
        ),
      },
    ],
    ['错误依据', { role: '研发岗', evidence: { role: [] } }],
    ['过多亮点', { role: '研发岗', highlights: Array(5).fill('亮点') }],
    [
      '过多材料',
      { role: '研发岗', requirements: Array(21).fill({ name: '简历' }) },
    ],
    ['过多标签', { role: '研发岗', tags: Array(21).fill('标签') }],
    [
      '过多任务',
      {
        role: '研发岗',
        tasks: Array(5).fill({
          title: '检查材料',
          dueAt: null,
          source: 'ai',
          estimatedMinutes: 30,
        }),
      },
    ],
    [
      '负耗时',
      {
        role: '研发岗',
        tasks: [
          {
            title: '检查材料',
            dueAt: null,
            source: 'ai',
            estimatedMinutes: -1,
          },
        ],
      },
    ],
    [
      '过大耗时',
      {
        role: '研发岗',
        tasks: [
          {
            title: '检查材料',
            dueAt: null,
            source: 'ai',
            estimatedMinutes: 1441,
          },
        ],
      },
    ],
    [
      '非整数耗时',
      {
        role: '研发岗',
        tasks: [
          {
            title: '检查材料',
            dueAt: null,
            source: 'ai',
            estimatedMinutes: 1.5,
          },
        ],
      },
    ],
    [
      '任务时间错误',
      {
        role: '研发岗',
        tasks: [
          {
            title: '检查材料',
            dueAt: '2026-02-30',
            source: 'ai',
            estimatedMinutes: 30,
          },
        ],
      },
    ],
  ])('拒绝%s', (_name, input) => {
    expect(() => validate(input)).toThrow();
  });

  it.each([
    '2026-02-29',
    '2026-02-30T12:00:00+08:00',
    '2026-13-01',
    '2026-00-01',
    '2026-04-31',
    '2026-12-01T25:00:00Z',
    '2026-12-01T12:60:00Z',
    '2026-12-01T12:00:60Z',
    '2026-12-01T12:00:00+24:00',
    '2026-12-01T12:00:00+08:60',
    '2026-12-01T12:00:00',
    '',
  ])('拒绝无效或歧义日期 %s', (deadline) => {
    expect(() => validate({ role: '研发岗', deadline })).toThrow();
  });

  it.each([
    '2024-02-29T12:00:00+08:00',
    '2026-12-01T12:00Z',
    '2026-12-01T12:00:00.123-05:00',
  ])('规范化有效日期 %s', (deadline) => {
    expect(
      validateAiExtraction(
        { role: '研发岗', deadline },
        fallback,
        `研发岗\n报名截止：${deadline}`,
        '',
      ).extraction.deadline,
    ).toBe(new Date(deadline).toISOString());
  });
  it('只有日期时使用上海 23:59，支持已过期日期及 null', () => {
    expect(
      validateAiExtraction(
        { role: '研发岗', deadline: '2020-01-31' },
        fallback,
        '研发岗\n报名截止：2020-01-31',
        '',
      ).extraction.deadline,
    ).toBe('2020-01-31T15:59:00.000Z');
    expect(
      validate({ role: '研发岗', deadline: null }).extraction.deadline,
    ).toBeNull();
  });
  it('原文没有截止日期时移除虚构日期及其派生任务时间', () => {
    const result = validateAiExtraction(
      {
        role: '研发岗',
        deadline: '2030-01-01',
        tasks: [
          {
            title: '准备材料',
            dueAt: '2029-12-30',
            estimatedMinutes: 30,
            source: 'ai',
          },
        ],
      },
      fallback,
      '星河科技｜研发岗\n工作地点：上海\n长期招聘',
      '',
    );
    expect(result.extraction.deadline).toBeNull();
    expect(result.extraction.tasks[0].dueAt).toBeNull();
    expect(result.correctedFields).toContain('deadline');
  });
  it('保留原文具体秒数，校正 AI 擅自改动的截止时间', () => {
    const result = validateAiExtraction(
      { role: '研发岗', deadline: '2030-01-01' },
      fallback,
      '星河科技｜研发岗\n报名截止：2026-12-31 23:59:59',
      '',
    );
    expect(result.extraction.deadline).toBe('2026-12-31T15:59:59.000Z');
    expect(result.extraction.evidence.deadline).toContain('23:59:59');
  });
  it('多个报名日期且没有可核对的引用时不擅自选择', () => {
    const result = validateAiExtraction(
      { role: '研发岗', deadline: '2026-12-20' },
      fallback,
      '研发岗\n一批报名截止：2026-12-20\n二批报名截止：2026-12-31',
      '',
    );
    expect(result.extraction.deadline).toBeNull();
  });
  it('已存在但与字段无关的引用不能支持虚构公司与地点', () => {
    const result = validate({
      organization: '虚构公司',
      role: '虚构岗位',
      location: '北京',
      evidence: { organization: '研发岗', location: '上海' },
    });
    expect(result.extraction.organization).toBe('星河科技');
    expect(result.extraction.role).toBe('研发岗');
    expect(result.extraction.location).toBe('上海');
    expect(result.correctedFields).toEqual([
      'organization',
      'role',
      'location',
    ]);
  });
  it('遗漏字段使用规则；明确空数组不被规则覆盖；最终完整 schema 可读', () => {
    const result = validate({
      role: '研发岗',
      tasks: [],
      requirements: [],
      highlights: [],
      risks: [],
    }).extraction;
    expect(result.organization).toBe('星河科技');
    expect(result.tasks).toEqual([]);
    expect(result.requirements).toEqual([]);
    expect(result.evidence).toEqual({});
    expect(result.confidence).toBe(0);
    expect(extractionSchema.safeParse(result).success).toBe(true);
  });
  it('不接受 AI 改写来源、主观打分、计划时间或注入阶段；任务来源由服务决定', () => {
    const result = validate({
      organization: '星河科技',
      sourceUrl: 'http://evil.example',
      stage: 'offer',
      decision: 'pursue',
      fitScore: 5,
      interestScore: 5,
      nextActionAt: '2026-12-01',
      tasks: [
        {
          title: '检查简历',
          dueAt: '2026-12-19',
          estimatedMinutes: 20,
          source: 'rule',
        },
      ],
    }).extraction;
    expect(result.sourceUrl).toBe('https://jobs.example.com/1');
    expect(result).not.toHaveProperty('stage');
    expect(result.decision).toBe('undecided');
    expect(result.fitScore).toBe(0);
    expect(result.interestScore).toBe(0);
    expect(result.nextActionAt).toBeNull();
    expect(result.tasks[0].source).toBe('ai');
    expect(validate({ role: '研发岗' }).extraction.tasks[0].source).toBe(
      'rule',
    );
  });
  it('只保留可定位的短句和有效字段索引，不认可幻觉证据', () => {
    const result = validate({
      role: '研发岗',
      tasks: [
        { title: '准备简历', dueAt: null, estimatedMinutes: 20, source: 'ai' },
      ],
      evidence: {
        organization: '星河 科技',
        role: '不存在的岗位',
        'tasks[0].title': '请准备简历',
        'tasks[99].title': '简历',
        'requirements[0].name': '简历',
        nextActionAt: '2026-12-20',
        unknown: '上海',
      },
    });
    expect(result.extraction.evidence).toEqual({
      organization: '星河 科技',
      'tasks[0].title': '请准备简历',
      'requirements[0].name': '简历',
    });
    expect(result.omittedProof).toBe(true);
  });
});

describe('AI 响应信封及下载上限', () => {
  const response = (content: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  it('读取标准内容并移除 Markdown 外层代码块', async () => {
    expect(
      await readAiContent(response('```json\n{"role":"研发岗"}\n```')),
    ).toBe('{"role":"研发岗"}');
  });
  it.each([null, 4, [], {}, '', 'a'.repeat(64_001)])(
    '拒绝非文本或超长 content（%#）',
    async (content) => {
      await expect(readAiContent(response(content))).rejects.toThrow();
    },
  );
  it('拒绝缺少 choices、空列表、坏 JSON 和无响应体', async () => {
    for (const body of ['{}', '{"choices":[]}', 'not-json'])
      await expect(readAiContent(new Response(body))).rejects.toThrow();
    await expect(readAiContent(new Response(null))).rejects.toThrow();
  });
  it('在 Content-Length 超限时不读取正文', async () => {
    await expect(
      readAiContent(
        new Response('bad', {
          headers: { 'Content-Length': String(AI_RESPONSE_MAX_BYTES + 1) },
        }),
      ),
    ).rejects.toThrow('AI 响应过大');
  });
  it('无长度头或长度头不可信时也按流限制，超限取消上游', async () => {
    const cancel = vi.fn();
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(8192));
        sent++;
      },
      cancel,
    });
    await expect(
      readAiContent(
        new Response(stream, { headers: { 'Content-Length': '1' } }),
      ),
    ).rejects.toThrow('AI 响应过大');
    expect(cancel).toHaveBeenCalled();
    expect(sent).toBeLessThan(40);
  });
});

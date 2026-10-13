import { describe, expect, it } from 'vitest';
import { findDuplicateOpportunity } from './opportunity-duplicate';
const rows = [
  {
    id: 'existing',
    organization: '星河科技',
    role: 'EHS专员（安全方向）',
    sourceUrl:
      'https://jobs.example.com/detail?id=218174620417656361&source=campus',
  },
];
describe('已收集机会的统一去重', () => {
  it('已有同名记录时优先打开链接完全对应的机会', () => {
    const second = {
      ...rows[0],
      id: 'same-name',
      sourceUrl: 'https://jobs.example.com/second',
    };
    expect(findDuplicateOpportunity([...rows, second], { ...second })?.id).toBe(
      'same-name',
    );
  });
  it('忽略追踪参数、片段与参数顺序，保留超长岗位 ID', () => {
    expect(
      findDuplicateOpportunity(rows, {
        sourceUrl:
          'https://jobs.example.com/detail?utm_source=share&source=campus&id=218174620417656361#detail',
      })?.id,
    ).toBe('existing');
    expect(
      findDuplicateOpportunity(rows, {
        sourceUrl:
          'https://jobs.example.com/detail?id=218174620417656362&source=campus',
      }),
    ).toBeUndefined();
  });
  it('相同公司和岗位忽略大小写、空白及全角标点差异', () => {
    expect(
      findDuplicateOpportunity(rows, {
        organization: ' 星河 科技 ',
        role: 'ehs专员 (安全方向)',
      })?.id,
    ).toBe('existing');
  });
  it('不同岗位、不同公司及缺失身份不会被合并', () => {
    for (const candidate of [
      { organization: '星河科技', role: '环境工程师' },
      { organization: '其他公司', role: rows[0].role },
      { organization: '星河科技', role: '' },
      { organization: '', role: rows[0].role },
      { sourceUrl: '' },
    ])
      expect(findDuplicateOpportunity(rows, candidate)).toBeUndefined();
  });
  it.each(['#/job/', '#!/job/', '#job?id=', '#job='])(
    '保留 %s 中的岗位标识，相同链接仍能去重',
    (route) => {
      const existing = [
        {
          ...rows[0],
          sourceUrl: `https://jobs.example.com/${route}218174620417656361`,
        },
      ];
      expect(
        findDuplicateOpportunity(existing, { sourceUrl: existing[0].sourceUrl })
          ?.id,
      ).toBe('existing');
      expect(
        findDuplicateOpportunity(existing, {
          sourceUrl: `https://jobs.example.com/${route}218174620417656362`,
        }),
      ).toBeUndefined();
      expect(
        findDuplicateOpportunity(existing, {
          sourceUrl: 'https://jobs.example.com/',
        }),
      ).toBeUndefined();
    },
  );
  it('Hash 路由的查询参数去掉追踪、排序，但保留业务参数', () => {
    const existing = [
      {
        ...rows[0],
        sourceUrl:
          'https://jobs.example.com/#/job?id=218174620417656361&source=campus',
      },
    ];
    expect(
      findDuplicateOpportunity(existing, {
        sourceUrl:
          'https://jobs.example.com/?utm_source=share#/job?utm_campaign=campus&source=campus&id=218174620417656361',
      })?.id,
    ).toBe('existing');
    expect(
      findDuplicateOpportunity(existing, {
        sourceUrl:
          'https://jobs.example.com/#/job?source=social&id=218174620417656361',
      }),
    ).toBeUndefined();
  });
});

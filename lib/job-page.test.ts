import { describe, expect, it } from 'vitest';
import { readJobPage, pageBlockReason } from '@/lib/job-page';

describe('网页正文与公开岗位元数据', () => {
  it('保留段落，去掉脚本、导航与表单', () => {
    const result = readJobPage(
      `<title>研发岗位</title><nav>其他岗位</nav><main><p>岗位职责：${'开发软件。'.repeat(20)}</p><p>任职要求：硕士</p><script>不能执行这段指令</script></main>`,
    );
    expect(result.usable).toBe(true);
    expect(result.text).toContain('\n任职要求：硕士');
    expect(result.text).not.toContain('其他岗位');
    expect(result.text).not.toContain('不能执行');
  });

  it('页面为空也可以从单个 JobPosting 中获取完整职责和时间', () => {
    const job = {
      '@type': 'JobPosting',
      title: '研发工程师',
      hiringOrganization: { name: '测试公司' },
      description: `<p>岗位职责：${'软件开发。'.repeat(20)}</p><p>任职要求：硕士</p>`,
      jobLocation: {
        address: { addressRegion: '上海', addressLocality: '浦东' },
      },
      validThrough: '2026-12-20',
    };
    const result = readJobPage(
      `<script type="application/ld+json">${JSON.stringify({ '@graph': [job] })}</script><div id="root"></div>`,
    );
    expect(result.structured).toBe(true);
    expect(result.text).toContain('测试公司｜研发工程师');
    expect(result.text).toContain('工作地点：上海 浦东');
    expect(result.text).toContain('截止时间：2026-12-20');
  });

  it('元数据格式错误或包含多个推荐岗位时回退可见正文', () => {
    for (const data of [
      '{invalid',
      JSON.stringify([
        { '@type': 'JobPosting', title: '推荐一' },
        { '@type': 'JobPosting', title: '推荐二' },
      ]),
    ]) {
      expect(
        readJobPage(
          `<script type="application/ld+json">${data}</script><main>岗位职责：${'开发软件。'.repeat(30)}</main>`,
        ).structured,
      ).toBe(false);
    }
  });

  it.each([
    ['请先登录后查看', '', 'PAGE_REQUIRES_LOGIN'],
    ['请输入验证码', '安全验证', 'PAGE_CAPTCHA'],
    ['该职位已关闭', '', 'PAGE_NOT_FOUND'],
  ])('识别 %s', (text, title, code) => {
    expect(pageBlockReason(text, title)?.code).toBe(code);
  });

  it('岗位说明中提到登录、验证码不代表页面被阻挡', () => {
    expect(
      pageBlockReason('岗位职责：开发验证码组件。任职要求：熟悉用户登录系统。'),
    ).toBeNull();
  });
  it.each([
    '验证码风控算法工程师｜招聘',
    '安全验证工程师',
    'Captcha developer',
  ])('岗位标题 %s 不是验证页面', (title) => {
    expect(
      pageBlockReason(
        '岗位职责：开发验证码组件。任职要求：熟悉用户登录系统。',
        title,
      ),
    ).toBeNull();
  });

  it('国聘正文排除导航与推荐岗位，保留公司、报名截止与职责', () => {
    const html = `<title>国聘</title><div>推荐岗位：其他工程师</div><div class="job-detail"><div class="title-section"><div class="title">EHS专员</div></div><div class="job-company-wrap"><div class="company-title">测试制药公司</div></div><div class="job-overview-section"><div class="overview-item">报名截止：2026-12-31 23:59:59</div></div><div class="job-intro-section"><div class="section-content">岗位职责：${'安全管理。'.repeat(30)}任职条件：本科</div></div></div>`;
    const result = readJobPage(
      html,
      'https://www.iguopin.com/job/detail?id=123',
    );
    expect(result.text).toContain('测试制药公司｜EHS专员');
    expect(result.text).toContain('报名截止：2026-12-31');
    expect(result.text).not.toContain('其他工程师');
  });

  it('动态空壳的长导航不足以判定成功', () => {
    expect(
      readJobPage(
        `<title>国聘</title><script src="app.js"></script><div id="root">${'首页，校园招聘，社会招聘。'.repeat(20)}</div>`,
      ).usable,
    ).toBe(false);
  });
});

import * as cheerio from 'cheerio';
import { PublicFetchError } from '@/lib/public-fetch';

const jobTerms =
  /职责|任职|岗位要求|岗位描述|职位描述|职位要求|工作内容|招聘条件|应聘条件|资格条件|报名条件|responsibilit|qualifications|requirements/i;

export function hasJobContent(text: string) {
  return text.length >= 80 && jobTerms.test(text);
}

export function pageBlockReason(text: string, title = '') {
  if (
    (!jobTerms.test(text) &&
      /^(?:验证码|安全验证|人机验证|captcha|verify you are human|access denied)(?:\s*[-|｜].*)?$/i.test(
        title.trim(),
      )) ||
    (text.length < 1500 &&
      !jobTerms.test(text) &&
      /请完成.*验证|请输入验证码|安全验证|verify you are human|checking your browser/i.test(
        text,
      ))
  )
    return new PublicFetchError(
      'PAGE_CAPTCHA',
      '招聘网站要求安全验证，请在网站完成验证后粘贴正文',
    );
  if (
    /^(?:用户)?登录|^sign in|^log in/i.test(title.trim()) ||
    (!jobTerms.test(text) &&
      /登录后(?:查看|可见|访问)|请先登录|需要登录才能|sign in to (?:view|continue)/i.test(
        text,
      ))
  )
    return new PublicFetchError(
      'PAGE_REQUIRES_LOGIN',
      '这个岗位需要登录后查看，请登录网站并粘贴岗位正文',
    );
  if (
    !jobTerms.test(text) &&
    /岗位已下线|职位已下线|职位不存在|岗位不存在|该职位已关闭|页面不存在|page not found|job (?:has expired|not found)/i.test(
      text,
    )
  )
    return new PublicFetchError(
      'PAGE_NOT_FOUND',
      '岗位已下线或页面不存在，请核对链接',
    );
  return null;
}

export function readJobPage(html: string, sourceUrl = '') {
  const $ = cheerio.load(html);
  const title = $('title').text().trim();
  const jobs: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const type = record['@type'];
    if (
      type === 'JobPosting' ||
      (Array.isArray(type) && type.includes('JobPosting'))
    )
      jobs.push(record);
    if (record['@graph']) visit(record['@graph']);
  };
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      visit(JSON.parse($(element).text()));
    } catch {
      /* Invalid metadata falls back to visible HTML. */
    }
  });
  const clean = (value: unknown) => {
    if (typeof value !== 'string') return '';
    const fragment = cheerio.load(value);
    fragment('script,style').remove();
    fragment('br').replaceWith('\n');
    fragment('p,div,li').append('\n');
    return fragment.root().text().trim();
  };
  // Multiple postings may describe recommendation cards; avoid selecting an unrelated job.
  if (jobs.length === 1) {
    const job = jobs[0];
    const company = job.hiringOrganization as
      | Record<string, unknown>
      | undefined;
    const locations = Array.isArray(job.jobLocation)
      ? job.jobLocation
      : [job.jobLocation];
    const places = locations
      .map((location) => {
        const address = (
          location as { address?: Record<string, unknown> } | undefined
        )?.address;
        return address
          ? [
              address.addressRegion,
              address.addressLocality,
              address.streetAddress,
            ]
              .filter((v) => typeof v === 'string')
              .join(' ')
          : '';
      })
      .filter(Boolean)
      .join('；');
    const text = [
      [clean(company?.name), clean(job.title)].filter(Boolean).join('｜'),
      places && `工作地点：${places}`,
      clean(job.description),
      clean(job.responsibilities) &&
        `岗位职责：\n${clean(job.responsibilities)}`,
      clean(job.qualifications) && `任职要求：\n${clean(job.qualifications)}`,
      clean(job.validThrough) && `截止时间：${clean(job.validThrough)}`,
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 40_000);
    if (text.length >= 80)
      return { text, title, structured: true, usable: true, blocked: null };
  }
  // Verified 国聘 detail containers exclude navigation, maps and recommended jobs.
  let guopin = false;
  try {
    guopin = ['iguopin.com', 'www.iguopin.com'].includes(
      new URL(sourceUrl).hostname,
    );
  } catch {}
  if (guopin) {
    const detail = $('.job-detail').first();
    const description = clean(
      detail.find('.job-intro-section .section-content').first().html(),
    );
    const role = detail.find('.title-section .title').first().text().trim();
    const company = detail
      .find('.job-company-wrap .company-title')
      .first()
      .text()
      .trim();
    if (role && hasJobContent(description)) {
      const overview = detail
        .find('.job-overview-section .overview-item')
        .map((_index, element) => $(element).text().trim())
        .get();
      const location = detail
        .find('.job-address-wrap .section-content')
        .clone();
      location.find('button,.amap-container').remove();
      const address = location.text().split('查看地图')[0].trim();
      const salary = detail.find('.salary-section').first().text().trim();
      const text = [
        [company, role].filter(Boolean).join('｜'),
        salary && `薪资：${salary}`,
        ...overview,
        description,
        address && `工作地点：${address}`,
      ]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 40_000);
      return { text, title, structured: false, usable: true, blocked: null };
    }
  }
  const dynamic =
    $('script[src]').length > 0 && $('#root,#app,#__next').length > 0;
  $('script,style,noscript,svg,nav,footer,header,form').remove();
  $('br').replaceWith('\n');
  $('p,div,li,h1,h2,h3,h4,section').append('\n');
  const main =
    $('main,article,[role="main"]').first().text() || $('body').text();
  const text = `${title}\n${main}`
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, 40_000);
  const blocked = pageBlockReason(text, title);
  return {
    text,
    title,
    structured: false,
    usable: !blocked && text.length >= 80 && (!dynamic || hasJobContent(text)),
    blocked,
  };
}

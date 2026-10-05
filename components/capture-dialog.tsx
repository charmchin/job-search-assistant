'use client';

import { useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  FileText,
  Link2,
  Loader2,
  Paperclip,
  Plus,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Field,
  fromInputDate,
  Notice,
  toInputDate,
} from '@/components/workspace-common';
import type { Extraction, Material, Mutate } from '@/lib/client-types';
import type { SavedDraft } from '@/components/paged-workspace';
import { buildRecordUpdate } from '@/lib/record-edit';
import { EditConflictNotice } from './edit-conflict-notice';

type CaptureResponse = {
  id?: string;
  extraction?: Extraction;
  warning?: string;
  mode?: string;
  adapter?: string;
  error?: string;
  guidance?: string;
  needsText?: boolean;
  duplicateId?: string;
};

export function CaptureDialog({
  open,
  onOpenChange,
  mutate,
  onCreated,
  initialDraft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mutate: Mutate;
  onCreated: (id: string) => void;
  initialDraft?: SavedDraft | null;
}) {
  const [url, setUrl] = useState(initialDraft?.sourceUrl ?? '');
  const [text, setText] = useState(initialDraft?.sourceText ?? '');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(initialDraft?.warning ?? '');
  const [guidance, setGuidance] = useState('');
  const [draftId, setDraftId] = useState(
    initialDraft?.extraction ? initialDraft.id : '',
  );
  const [draft, setDraft] = useState<Extraction | null>(
    initialDraft?.extraction ?? null,
  );
  const [sourceStatus, setSourceStatus] = useState(
    initialDraft ? '已保存草稿 · 待确认' : '',
  );
  const [mode, setMode] = useState(initialDraft ? 'saved' : 'rules');
  const scrollRef = useRef<HTMLDivElement>(null);
  const actionLock = useRef(false);
  const reset = () => {
    setUrl('');
    setText('');
    setMessage('');
    setGuidance('');
    setDraft(null);
    setDraftId('');
    setSourceStatus('');
    setMode('rules');
  };
  const close = (next: boolean) => {
    if (actionLock.current && !next) return;
    onOpenChange(next);
    if (!next) reset();
  };
  const extract = async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setLoading(true);
    setMessage('');
    setGuidance('');
    setSourceStatus(
      url && !text ? '正在读取招聘页面…' : '正在整理你粘贴的正文…',
    );
    try {
      const response = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, text }),
      });
      const result = (await response.json()) as CaptureResponse;
      if (!response.ok) {
        if (result.duplicateId) {
          setMessage(
            '这个岗位已经在机会库里了。可以关闭窗口后从机会库继续推进。',
          );
          setSourceStatus('');
          return;
        }
        setMessage(result.error || '暂时无法整理这个岗位');
        setGuidance(
          result.guidance ||
            (result.needsText
              ? '请复制招聘页中的岗位职责、任职要求和截止时间，粘贴到正文框后继续。'
              : '请检查输入内容后重试。'),
        );
        setSourceStatus('');
        return;
      }
      setDraft(result.extraction || null);
      setMode(result.mode || 'rules');
      setDraftId(result.id || '');
      setSourceStatus(
        result.adapter === 'tencent'
          ? '腾讯招聘 · 官方岗位数据'
          : text
            ? '粘贴正文 · 已解析'
            : '公开网页 · 已读取',
      );
      setMessage(
        result.warning || '岗位已经整理成草稿，请完成投入判断后保存。',
      );
      requestAnimationFrame(() =>
        scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }),
      );
    } catch {
      setMessage('连接本地服务时出现问题');
      setGuidance('链接和正文都没有丢失。请确认服务仍在运行，然后重试。');
      setSourceStatus('');
    } finally {
      actionLock.current = false;
      setLoading(false);
    }
  };
  const save = async () => {
    if (!draft || actionLock.current) return;
    actionLock.current = true;
    setLoading(true);
    try {
      const result = await mutate('createOpportunity', {
        ...draft,
        notes: '',
        review: '',
        draftId,
      });
      onCreated((result as { id: string }).id);
      reset();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      actionLock.current = false;
      setLoading(false);
    }
  };
  const update = <K extends keyof Extraction>(key: K, value: Extraction[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  const addTextItem = (key: 'highlights' | 'risks', label: string) =>
    update(key, [...(draft?.[key] || []), label]);

  const returnToSource = () => {
    if (actionLock.current) return;
    setDraft(null);
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }),
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[92vh] w-[calc(100%_-_2rem)] max-w-4xl overflow-hidden border-[#ddd8ce] bg-[#f8f6f1] p-0 sm:max-w-4xl">
        <div
          ref={scrollRef}
          className="max-h-[92vh] overflow-x-hidden overflow-y-auto"
        >
          <DialogHeader className="border-b border-[#e3dfd6] bg-white/65 px-6 py-5 sm:px-8">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-2xl bg-[#e7f1ed] text-[#2d6b5d]">
                <WandSparkles className="size-5" />
              </div>
              <div>
                <DialogTitle className="text-xl">
                  {draft ? '把岗位变成可执行计划' : '收集一个招聘岗位'}
                </DialogTitle>
                <DialogDescription className="mt-1">
                  {draft
                    ? '先核对事实，再由你决定是否值得投入。'
                    : '粘贴链接即可；页面无法读取时，正文粘贴始终可用。'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {!draft ? (
            <div className="grid gap-6 px-6 py-6 sm:px-8 lg:grid-cols-[1fr_300px]">
              <div className="space-y-5">
                <Field label="招聘链接" hint="推荐">
                  <div className="relative">
                    <Link2 className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#8c867b]" />
                    <Input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://careers.tencent.com/..."
                      autoComplete="off"
                      spellCheck={false}
                      className="h-12 rounded-xl bg-white pl-10"
                    />
                  </div>
                </Field>
                <div className="flex items-center gap-3 text-[11px] font-medium text-[#9a948a]">
                  <div className="h-px flex-1 bg-[#e1ddd4]" />
                  页面需要登录或动态加载？直接粘贴正文
                  <div className="h-px flex-1 bg-[#e1ddd4]" />
                </div>
                <Field label="招聘正文" hint="可选">
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="复制岗位名称、岗位职责、任职要求、截止时间、材料要求等内容…"
                    className="min-h-52 resize-y rounded-xl bg-white leading-6"
                  />
                </Field>
                {loading && (
                  <Notice
                    title={sourceStatus}
                    detail="通常只需要几秒，期间不会创建正式机会。"
                    tone="green"
                  />
                )}
                {message && (
                  <Notice
                    title={message}
                    detail={guidance}
                    tone={guidance ? 'amber' : 'green'}
                  />
                )}
              </div>
              <aside className="rounded-[22px] border border-[#e1ddd3] bg-white/70 p-5">
                <p className="text-xs font-bold tracking-wide text-[#5d766f]">
                  会整理什么
                </p>
                <div className="mt-5 space-y-4">
                  {[
                    [FileText, '岗位事实', '公司、岗位、地点、职责与门槛'],
                    [Sparkles, '判断线索', '亮点、硬性风险与特殊事项'],
                    [Check, '推进计划', '材料缺口、建议任务和下一步'],
                  ].map(([Icon, title, detail]) => {
                    const IconComponent = Icon as typeof FileText;
                    return (
                      <div key={String(title)} className="flex gap-3">
                        <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-[#edf3f0] text-[#3c7467]">
                          <IconComponent className="size-4" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold">
                            {String(title)}
                          </p>
                          <p className="mt-0.5 text-xs leading-5 text-[#837d73]">
                            {String(detail)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-6 rounded-xl bg-[#f2efe8] p-3 text-[11px] leading-5 text-[#7e786d]">
                  不会自动投递，也不会把未经确认的草稿写进机会库。
                </p>
              </aside>
            </div>
          ) : (
            <div className="space-y-7 px-6 py-6 sm:px-8">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="rounded-full bg-[#e6f2ed] text-[#2d6b5d]">
                  {sourceStatus}
                </Badge>
                <span className="text-xs text-[#7e786e]">{message}</span>
                <Badge variant="outline" className="rounded-full">
                  {mode === 'ai'
                    ? 'AI 草稿 · 已通过结构校验'
                    : mode === 'saved'
                      ? '保存的草稿 · 请核对'
                      : '本地规则 · 请核对'}
                </Badge>
              </div>
              <p className="text-xs leading-5 text-[#817b71]">
                原文依据只核对短句是否出现在来源正文，不代表字段一定准确。以下依据对应提取时的内容；手动修改后请重新核对。
                {mode === 'ai' &&
                  (draft.confidence
                    ? ` 模型自评 ${Math.round(draft.confidence * 100)}%，不是系统验证的准确率。`
                    : ' 模型未提供自评。')}
              </p>
              <section className="rounded-[22px] border border-[#e1ddd4] bg-white/75 p-5">
                <div className="mb-5">
                  <p className="text-xs font-bold tracking-[.14em] text-[#75847f]">
                    01 · 基本事实
                  </p>
                  <h3 className="mt-1 font-semibold">先确认岗位没有识别错</h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="公司 / 组织 *">
                    <Input
                      value={draft.organization}
                      aria-label="公司 / 组织 *"
                      onChange={(e) => update('organization', e.target.value)}
                    />
                    <Evidence quote={draft.evidence.organization} />
                  </Field>
                  <Field label="岗位 *">
                    <Input
                      value={draft.role}
                      aria-label="岗位 *"
                      onChange={(e) => update('role', e.target.value)}
                    />
                    <Evidence quote={draft.evidence.role} />
                  </Field>
                  <Field label="方向">
                    <Input
                      value={draft.direction}
                      aria-label="方向"
                      onChange={(e) => update('direction', e.target.value)}
                    />
                    <Evidence quote={draft.evidence.direction} />
                  </Field>
                  <Field label="地点">
                    <Input
                      value={draft.location}
                      aria-label="地点"
                      onChange={(e) => update('location', e.target.value)}
                    />
                    <Evidence quote={draft.evidence.location} />
                  </Field>
                  <Field label="截止时间">
                    <Input
                      type="datetime-local"
                      value={toInputDate(draft.deadline)}
                      aria-label="截止时间"
                      onChange={(e) =>
                        update('deadline', fromInputDate(e.target.value))
                      }
                    />
                    <Evidence quote={draft.evidence.deadline} />
                  </Field>
                  <Field label="优先级">
                    <select
                      value={draft.priority}
                      aria-label="优先级"
                      onChange={(e) =>
                        update(
                          'priority',
                          e.target.value as Extraction['priority'],
                        )
                      }
                      className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
                    >
                      <option value="high">重点</option>
                      <option value="medium">常规</option>
                      <option value="low">低优先</option>
                    </select>
                    <Evidence quote={draft.evidence.priority} />
                  </Field>
                </div>
              </section>
              <section className="rounded-[22px] border border-[#e1ddd4] bg-white/75 p-5">
                <div className="mb-5">
                  <p className="text-xs font-bold tracking-[.14em] text-[#75847f]">
                    02 · 投入判断
                  </p>
                  <h3 className="mt-1 font-semibold">
                    这个岗位值得你花多少时间？
                  </h3>
                  <p className="mt-1 text-xs text-[#817b71]">
                    匹配度和兴趣度必须由你判断；系统不会替你编造。
                  </p>
                </div>
                <div className="grid gap-5 sm:grid-cols-3">
                  <ScorePicker
                    label="匹配度"
                    value={draft.fitScore}
                    onChange={(value) => update('fitScore', value)}
                  />
                  <ScorePicker
                    label="兴趣度"
                    value={draft.interestScore}
                    onChange={(value) => update('interestScore', value)}
                  />
                  <Field label="投入决定">
                    <select
                      value={draft.decision}
                      onChange={(e) =>
                        update(
                          'decision',
                          e.target.value as Extraction['decision'],
                        )
                      }
                      className="h-11 w-full rounded-xl border border-input bg-white px-3 text-sm"
                    >
                      <option value="undecided">还没判断</option>
                      <option value="pursue">值得投入</option>
                      <option value="hold">暂缓观察</option>
                      <option value="skip">不再考虑</option>
                    </select>
                  </Field>
                </div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <TextList
                    title="岗位亮点"
                    items={draft.highlights}
                    onChange={(items) => update('highlights', items)}
                    onAdd={() => addTextItem('highlights', '补充一条亮点')}
                  />
                  <TextList
                    title="门槛与风险"
                    items={draft.risks}
                    onChange={(items) => update('risks', items)}
                    onAdd={() => addTextItem('risks', '补充一条风险')}
                  />
                </div>
              </section>
              <section className="rounded-[22px] border border-[#e1ddd4] bg-white/75 p-5">
                <div className="mb-5">
                  <p className="text-xs font-bold tracking-[.14em] text-[#75847f]">
                    03 · 下一步
                  </p>
                  <h3 className="mt-1 font-semibold">
                    保存后，首页会优先推动这一步
                  </h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-[1fr_230px]">
                  <Field label="明确的下一步">
                    <Input
                      value={draft.nextAction}
                      onChange={(e) => update('nextAction', e.target.value)}
                      placeholder="例如：核对工作年限要求是否匹配"
                    />
                  </Field>
                  <Field label="计划完成时间">
                    <Input
                      type="datetime-local"
                      value={toInputDate(draft.nextActionAt)}
                      onChange={(e) =>
                        update('nextActionAt', fromInputDate(e.target.value))
                      }
                    />
                  </Field>
                </div>
                <div className="mt-5">
                  <p className="mb-2 text-sm font-semibold">建议任务</p>
                  <div className="space-y-2">
                    {draft.tasks.map((task, index) => (
                      <div
                        key={index}
                        className="grid gap-2 rounded-xl border border-[#e8e4db] bg-[#fcfbf8] p-3 sm:grid-cols-[1fr_190px_36px]"
                      >
                        <Input
                          value={task.title}
                          onChange={(e) =>
                            update(
                              'tasks',
                              draft.tasks.map((item, i) =>
                                i === index
                                  ? { ...item, title: e.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                        <Input
                          type="datetime-local"
                          value={toInputDate(task.dueAt)}
                          onChange={(e) =>
                            update(
                              'tasks',
                              draft.tasks.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      dueAt: fromInputDate(e.target.value),
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            update(
                              'tasks',
                              draft.tasks.filter((_, i) => i !== index),
                            )
                          }
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
              <section className="grid gap-5 sm:grid-cols-2">
                <div className="rounded-[22px] border border-[#e1ddd4] bg-white/75 p-5">
                  <p className="mb-3 text-sm font-semibold">材料要求</p>
                  <div className="flex flex-wrap gap-2">
                    {draft.requirements.map((item, index) => (
                      <Badge
                        key={`${item.name}-${index}`}
                        variant="secondary"
                        className="gap-1 rounded-full py-1.5"
                      >
                        {item.name}
                        <button
                          onClick={() =>
                            update(
                              'requirements',
                              draft.requirements.filter((_, i) => i !== index),
                            )
                          }
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    ))}
                    {!draft.requirements.length && (
                      <span className="text-xs text-[#898379]">
                        未识别到明确材料
                      </span>
                    )}
                  </div>
                </div>
                <div className="rounded-[22px] border border-[#e1ddd4] bg-white/75 p-5">
                  <Field label="特殊注意事项">
                    <Textarea
                      value={draft.specialNotes}
                      onChange={(e) => update('specialNotes', e.target.value)}
                      className="min-h-28"
                    />
                  </Field>
                </div>
              </section>
              <details className="rounded-[22px] border border-[#e1ddd4] bg-white/60 p-5">
                <summary className="cursor-pointer text-sm font-semibold">
                  提取时的字段依据 · 材料、任务与判断线索
                </summary>
                <p className="mt-2 text-xs leading-5 text-[#817b71]">
                  任务通常是建议，并非招聘方要求。未提供依据的内容，请回到原招聘信息核对。
                </p>
                <div className="mt-4 space-y-3">
                  {Object.entries(draft.evidence)
                    .filter(
                      ([key, quote]) =>
                        quote &&
                        ![
                          'organization',
                          'role',
                          'direction',
                          'location',
                          'deadline',
                          'priority',
                        ].includes(key),
                    )
                    .map(([key, quote]) => (
                      <div key={key}>
                        <p className="text-xs font-semibold">
                          {evidenceLabel(key)}
                        </p>
                        <Evidence quote={quote} />
                      </div>
                    ))}
                  {!Object.values(draft.evidence).some(Boolean) && <Evidence />}
                </div>
              </details>
              <details className="rounded-[22px] border border-[#e1ddd4] bg-white/60 p-5">
                <summary className="cursor-pointer text-sm font-semibold">
                  查看与修改岗位正文
                </summary>
                <Textarea
                  value={draft.description}
                  onChange={(e) => update('description', e.target.value)}
                  className="mt-4 min-h-56 leading-6"
                />
              </details>
            </div>
          )}
          <DialogFooter className="sticky bottom-0 m-0 border-t border-[#e1ddd4] bg-[#f8f6f1]/95 px-6 py-4 backdrop-blur sm:px-8">
            {draft ? (
              <>
                <Button variant="ghost" onClick={returnToSource}>
                  <ArrowLeft />
                  返回来源
                </Button>
                <Button
                  className="rounded-xl bg-[#173f37] hover:bg-[#245d50]"
                  onClick={() => void save()}
                  disabled={loading || !draft.organization || !draft.role}
                >
                  {loading ? <Loader2 className="animate-spin" /> : <Check />}
                  保存到机会库
                </Button>
              </>
            ) : (
              <Button
                className="rounded-xl bg-[#173f37] hover:bg-[#245d50]"
                onClick={() => void extract()}
                disabled={loading || (!url && !text)}
              >
                {loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
                整理岗位信息
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Evidence({ quote }: { quote?: string }) {
  return (
    <p
      className={`mt-2 break-words text-[11px] leading-5 ${quote ? 'border-l-2 border-[#b8d0c5] pl-2 text-[#60786d]' : 'text-[#9a8370]'}`}
    >
      {quote ? `提取时原文：“${quote}”` : '未找到原文依据，请手动核对'}
    </p>
  );
}

function evidenceLabel(key: string) {
  const labels: Record<string, string> = {
    sourceName: '来源',
    description: '岗位正文',
    tags: '标签',
    specialNotes: '特殊注意事项',
    highlights: '岗位亮点',
    risks: '门槛与风险',
    requirements: '材料要求',
    tasks: '建议任务',
  };
  const indexed =
    /^(tasks|requirements|highlights|risks)\[(\d+)\](?:\.(title|dueAt|name))?$/.exec(
      key,
    );
  return indexed
    ? `${labels[indexed[1]]} · 提取时第 ${Number(indexed[2]) + 1} 项${indexed[3] === 'dueAt' ? '时间' : ''}`
    : labels[key] || key;
}

function ScorePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={value ? `${value}/5` : '未判断'}>
      <div className="flex h-11 items-center gap-1 rounded-xl border border-input bg-white px-2">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            type="button"
            key={score}
            onClick={() => onChange(score)}
            className={`grid size-8 place-items-center rounded-lg text-xs font-semibold transition ${score <= value ? 'bg-[#dcece6] text-[#285f53]' : 'text-[#aaa49a] hover:bg-[#f1efe9]'}`}
          >
            {score}
          </button>
        ))}
      </div>
    </Field>
  );
}
function TextList({
  title,
  items,
  onChange,
  onAdd,
}: {
  title: string;
  items: string[];
  onChange: (items: string[]) => void;
  onAdd: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">{title}</p>
        <button
          onClick={onAdd}
          className="flex items-center gap-1 text-xs text-[#397365]"
        >
          <Plus className="size-3" />
          补充
        </button>
      </div>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={index} className="flex gap-2">
            <Input
              value={item}
              onChange={(e) =>
                onChange(
                  items.map((current, i) =>
                    i === index ? e.target.value : current,
                  ),
                )
              }
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
        {!items.length && (
          <p className="rounded-xl border border-dashed border-[#ddd8cf] p-3 text-xs text-[#8d877d]">
            尚未识别，可保存后再补充。
          </p>
        )}
      </div>
    </div>
  );
}

export function MaterialDialog({
  open,
  onOpenChange,
  mutate,
  material,
  linkedCount = 0,
  latestMaterial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mutate: Mutate;
  material?: Material | null;
  linkedCount?: number;
  latestMaterial?: Material | null;
}) {
  const [original, setOriginal] = useState(material);
  const [form, setForm] = useState({
    name: material?.name ?? '',
    filePath: material?.filePath ?? '',
    version: material?.version ?? '',
    category: material?.category ?? '简历',
    notes: material?.notes ?? '',
  });
  const [loading, setLoading] = useState(false);
  const picking = useRef(false);
  const savingLock = useRef(false);
  const [pickPending, setPickPending] = useState(false);
  const [fileError, setFileError] = useState('');
  const pick = async () => {
    if (picking.current) return;
    picking.current = true;
    setPickPending(true);
    setFileError('');
    try {
      const response = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pick' }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法选择文件');
      if (result.path)
        setForm((current) => ({ ...current, filePath: result.path }));
    } catch (error) {
      setFileError(
        error instanceof Error ? error.message : '文件选择失败，请重试。',
      );
    } finally {
      picking.current = false;
      setPickPending(false);
    }
  };
  const save = async () => {
    if (picking.current || savingLock.current) return;
    savingLock.current = true;
    setLoading(true);
    setFileError('');
    try {
      const update = original
        ? buildRecordUpdate('material', original, form)
        : form;
      if (update)
        await mutate(original ? 'updateMaterial' : 'createMaterial', update);
      onOpenChange(false);
      setForm({
        name: '',
        filePath: '',
        version: '',
        category: '简历',
        notes: '',
      });
    } catch (error) {
      setFileError(
        error instanceof Error ? error.message : '材料保存失败，请重试。',
      );
    } finally {
      savingLock.current = false;
      setLoading(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (picking.current || savingLock.current)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-[#ddd8ce] bg-[#f8f6f1] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {material ? '编辑申请材料' : '添加申请材料'}
          </DialogTitle>
          <DialogDescription>
            只记录路径，不上传。请选择 PDF、普通 Office
            文档、文本或图片；不支持程序、脚本及 DOCM 等含宏格式。
          </DialogDescription>
        </DialogHeader>
        {material && linkedCount > 0 && (
          <Notice
            title={`关联 ${linkedCount} 项岗位要求`}
            detail="修改路径或版本后，关联要求会恢复为待准备；核对新文件后，请重新标记就绪。修改名称或备注不影响就绪状态。"
          />
        )}
        <fieldset disabled={loading || pickPending} className="space-y-4">
          {original && (
            <EditConflictNotice
              kind="material"
              update={buildRecordUpdate('material', original, form)}
              current={latestMaterial}
              onDiscard={() => {
                if (!confirm('放弃本次未保存的材料修改？')) return;
                if (!latestMaterial) {
                  onOpenChange(false);
                  return;
                }
                setOriginal(latestMaterial);
                setForm({
                  name: latestMaterial.name,
                  filePath: latestMaterial.filePath,
                  version: latestMaterial.version,
                  category: latestMaterial.category,
                  notes: latestMaterial.notes,
                });
                setFileError('');
              }}
            />
          )}
          <Field label="材料名称 *">
            <Input
              aria-label="材料名称"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：算法岗中文简历"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="类型">
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
              >
                {![
                  '简历',
                  '成绩单',
                  '证书',
                  '作品集',
                  '推荐信',
                  '其他',
                ].includes(form.category) && <option>{form.category}</option>}
                <option>简历</option>
                <option>成绩单</option>
                <option>证书</option>
                <option>作品集</option>
                <option>推荐信</option>
                <option>其他</option>
              </select>
            </Field>
            <Field label="版本">
              <Input
                aria-label="材料版本"
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                placeholder="v2 / 算法岗"
              />
            </Field>
          </div>
          <Field label="本机文件">
            <div className="flex gap-2">
              <Input
                aria-label="本机文件路径"
                value={form.filePath}
                onChange={(e) => setForm({ ...form, filePath: e.target.value })}
                placeholder="选择或粘贴路径"
              />
              <Button
                variant="outline"
                disabled={pickPending || loading}
                onClick={() => void pick()}
              >
                {pickPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Paperclip />
                )}
                {pickPending ? '选择中…' : '选择'}
              </Button>
            </div>
          </Field>
          {fileError && (
            <p role="alert" className="text-sm leading-6 text-[#a64639]">
              {fileError}
            </p>
          )}
          <Field label="备注">
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </fieldset>
        <DialogFooter>
          <Button
            className="rounded-xl"
            onClick={() => void save()}
            disabled={
              loading ||
              pickPending ||
              !form.name.trim() ||
              Boolean(
                original && !buildRecordUpdate('material', original, form),
              )
            }
          >
            {loading && <Loader2 className="animate-spin" />}保存材料
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

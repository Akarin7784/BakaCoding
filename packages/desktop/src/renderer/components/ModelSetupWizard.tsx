// UI-03b：模型设置向导（docs/ui-design.md §4.1）。放在现有流程里的弹层：项目准备页检查都通过后、设置弹层里都能打开，
// 不新开页面。两步：1 密钥（SecretItem）→ 2 测试连接（provider:test，失败原因是主进程按码给的固定中文文案）。
// 角色分配和预算两步在 UI-07 的设置 › 模型 / 预算里做（这里不写 config/models.json）。
import { useState } from "react";
import { CircleAlert, CircleCheck, PlugZap } from "lucide-react";
import type { BakaDesktopApi, DesktopProviderTestResult } from "../../shared/api";
import { PROVIDER_TEST_TEXT } from "../../shared/secret-text";
import { providerTestNotSent, providerTestText, WIZARD_COPY } from "../lib/secretItem";
import { cn } from "../lib/utils";
import { SecretItem, type SecretApi } from "./SecretItem";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export type WizardApi = SecretApi & Pick<BakaDesktopApi, "testProvider">;

/** v1 只有 DeepSeek（§4.1）；模型不传，由 1 取配置里这个服务商的第一个模型 */
export const WIZARD_PROVIDER = "deepseek";

export function ModelSetupWizard({
  open,
  onOpenChange,
  api,
  initialStep = 0,
  initialResult = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: WizardApi;
  /** 截图 / 测试 */
  initialStep?: 0 | 1;
  initialResult?: DesktopProviderTestResult | null;
}) {
  const [step, setStep] = useState<0 | 1>(initialStep);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<DesktopProviderTestResult | null>(initialResult);

  const test = async () => {
    if (!api.testProvider || testing) return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.testProvider({ provider: WIZARD_PROVIDER }));
    } catch {
      setResult({ ok: false, code: "failed", reason: PROVIDER_TEST_TEXT.failed });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !testing && onOpenChange(o)}>
      <DialogContent data-testid="model-wizard" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{WIZARD_COPY.title}</DialogTitle>
          <DialogDescription>{WIZARD_COPY.description}</DialogDescription>
        </DialogHeader>
        <ol aria-label="步骤" className="flex items-center gap-2 text-xs">
          {WIZARD_COPY.steps.map((s, i) => (
            <li
              key={s}
              aria-current={step === i ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1",
                step === i ? "bg-secondary font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              <span>{i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        <p className="text-muted-foreground">{WIZARD_COPY.provider}</p>
        {step === 0 && <SecretItem api={api} name="DEEPSEEK_API_KEY" />}
        {step === 1 && (
          <section aria-label={WIZARD_COPY.test} className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Button disabled={testing || !api.testProvider} onClick={() => void test()}>
                <PlugZap strokeWidth={1.5} />
                {testing ? WIZARD_COPY.testing : WIZARD_COPY.test}
              </Button>
              <span className="text-xs text-muted-foreground">{WIZARD_COPY.testHint}</span>
            </div>
            {result && (
              <div
                data-testid="provider-test-result"
                data-code={result.ok ? "ok" : result.code}
                role={result.ok ? "status" : "alert"}
                className={cn(
                  "flex items-start gap-2 rounded-lg px-3 py-2",
                  result.ok ? "bg-secondary" : "bg-danger-soft",
                )}
              >
                {result.ok ? (
                  <CircleCheck size={18} strokeWidth={1.5} aria-hidden className="shrink-0" />
                ) : (
                  <CircleAlert
                    size={18}
                    strokeWidth={1.5}
                    aria-hidden
                    className="shrink-0 text-danger"
                  />
                )}
                <div className="min-w-0">
                  {!result.ok && <p className="font-medium">{WIZARD_COPY.failed}</p>}
                  <p className="break-words">{providerTestText(result)}</p>
                  {providerTestNotSent(result) &&
                    !providerTestText(result).includes(WIZARD_COPY.notSent) && (
                      <p className="text-xs text-muted-foreground">{WIZARD_COPY.notSent}</p>
                    )}
                </div>
              </div>
            )}
          </section>
        )}
        <DialogFooter>
          {step === 1 && (
            <Button variant="secondary" disabled={testing} onClick={() => setStep(0)}>
              {WIZARD_COPY.back}
            </Button>
          )}
          {step === 0 ? (
            <Button onClick={() => setStep(1)}>{WIZARD_COPY.next}</Button>
          ) : (
            <Button disabled={testing} onClick={() => onOpenChange(false)}>
              {WIZARD_COPY.done}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

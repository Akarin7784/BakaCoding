// T-081：导入失败只缺配置文件时的「缺配置」横幅（docs/ui-design.md §3、§4.7：页面横幅带操作按钮）。
// 详细原因在右下角错误 toast 里，这里只留一句说明和「用默认模板创建」。
import { CircleAlert, FilePlus } from "lucide-react";
import { CONFIG_COPY } from "../lib/copy";
import { Banner } from "./Banner";
import { Button } from "./ui/button";

export function MissingConfigBanner({
  busy,
  onCreate,
}: {
  /** 导入 / 创建配置进行中：按钮置灰，防重复点 */
  busy: boolean;
  onCreate: () => void;
}) {
  return (
    <Banner
      icon={CircleAlert}
      label={CONFIG_COPY.bannerLabel}
      testId="missing-config-banner"
      actions={
        <Button
          variant="secondary"
          size="sm"
          data-testid="create-default-config"
          disabled={busy}
          onClick={onCreate}
        >
          <FilePlus strokeWidth={1.5} />
          {CONFIG_COPY.create}
        </Button>
      }
    >
      <span>{CONFIG_COPY.text}</span>
    </Banner>
  );
}

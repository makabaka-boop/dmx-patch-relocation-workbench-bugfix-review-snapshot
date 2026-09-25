import { ReactNode } from "react";

/**
 * 逐字符渲染灯具 id：
 *
 * - 渲染结果的 textContent 与原 id **逐字节相同**（空格仍是真正的空格文本节点），
 *   选择、key、data-* 属性全部使用原始字符串，本组件不做任何 trim/折叠；
 * - 每个空格包一层带底纹与中点标记的 inline-block（white-space: pre），使前导、
 *   尾随、连续空格与全空格 id 可肉眼区分，也不会与相邻文本的空白发生折叠。
 *
 * id 协议限定为 1–32 位可打印 ASCII（U+0020–U+007E）。
 */
export function IdText({ id }: { id: string }): ReactNode {
  return (
    <span className="id-text" data-id={id} title={id}>
      {[...id].map((ch, i) =>
        ch === " " ? (
          <span key={i} className="id-space">
            {" "}
          </span>
        ) : (
          <span key={i} className="id-char">
            {ch}
          </span>
        ),
      )}
    </span>
  );
}

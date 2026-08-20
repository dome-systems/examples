import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** iOS home-screen icon — same mark as the tab favicon. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#2F5D50",
          borderRadius: 36,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            color: "#F3EBE0",
            fontSize: 110,
            fontWeight: 600,
            lineHeight: 1,
            fontFamily: "Georgia, serif",
          }}
        >
          ♔
        </div>
      </div>
    ),
    { ...size },
  );
}

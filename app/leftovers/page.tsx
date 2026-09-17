import type { Metadata } from "next";
import BakeryApp from "@/components/bakery-app";

export const metadata: Metadata = {
  title: "남은 빵 분석 · 내일의 빵",
  description: "매장 잔량의 요일별 변화와 9가지 예측 방법을 같은 날짜에서 비교합니다.",
};

export default function LeftoversPage() {
  return <BakeryApp initialTab="leftovers" />;
}

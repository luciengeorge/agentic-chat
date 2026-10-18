import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { OcrReview } from "#learn/parse/review";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { acceptOcrPage, correctOcrPage, getOcrReviews } from "@/lib/ocr-review.functions";

/** The pending OCR reviews of documents the viewer can read, lowest confidence first, with accept and correct. */
export function ReviewQueue() {
  const reviews = useQuery({ queryKey: ["labs", "parsing", "reviews"], queryFn: () => getOcrReviews({ data: {} }) });
  if (reviews.isPending) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (reviews.isError) return <p className="text-sm text-destructive">{reviews.error.message}</p>;
  if (reviews.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing waits for review. Open a scanned document above and queue its pages.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-3">
      {reviews.data.map((review) => (
        <ReviewCard key={review.id} review={review} />
      ))}
    </ol>
  );
}

function ReviewCard({ review }: { review: OcrReview }) {
  const client = useQueryClient();
  const [text, setText] = useState(review.ocrText);
  const done = () => client.invalidateQueries({ queryKey: ["labs", "parsing"] });
  const accept = useMutation({ mutationFn: () => acceptOcrPage({ data: { reviewId: review.id } }), onSuccess: done });
  const correct = useMutation({
    mutationFn: () => correctOcrPage({ data: { reviewId: review.id, text } }),
    onSuccess: done,
  });
  const error = accept.error ?? correct.error;
  const busy = accept.isPending || correct.isPending;
  return (
    <li className="flex flex-col gap-2 rounded-xl border px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">{review.title}</span>
        <span className="text-muted-foreground tabular-nums">page {review.page}</span>
        <span className="font-medium text-destructive tabular-nums">confidence {review.confidence}</span>
      </div>
      <Textarea
        aria-label={`What page ${review.page} says`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="max-h-64 font-mono text-xs"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => accept.mutate()}>
          Accept as read
        </Button>
        <Button size="sm" disabled={busy || text.trim() === review.ocrText.trim()} onClick={() => correct.mutate()}>
          Save correction
        </Button>
        {correct.isPending ? <span className="text-xs text-muted-foreground">Cutting the page again…</span> : null}
        {error ? <span className="text-xs text-destructive">{error.message}</span> : null}
      </div>
    </li>
  );
}

if ((data.rating ?? 0) < 3) return {};
return { actions: [{ action: "moderate_review", reviewId: data.reviewId, status: "APPROVED" }] };

import type { List } from '$types/lists';

import { toast } from 'svelte-sonner';

export function formatElapsedTime(date: string | Date): string {
	const parsedDate = date instanceof Date ? date : new Date(date);

	if (isNaN(parsedDate.getTime())) {
		throw new Error('Invalid date provided.');
	}

	const currentDate = new Date();
	const differenceInMillis = currentDate.getTime() - parsedDate.getTime();

	if (differenceInMillis < 1000 * 60) {
		// If less than a minute, display "seconds"
		return 'seconds';
	} else if (differenceInMillis < 1000 * 60 * 60) {
		// If less than an hour, show minutes
		const minutesElapsed = Math.floor(differenceInMillis / (1000 * 60));
		return minutesElapsed === 1 ? '1 minute' : `${minutesElapsed} minutes`;
	} else if (differenceInMillis < 1000 * 60 * 60 * 24) {
		// If less than a day, show hours
		const hoursElapsed = Math.floor(differenceInMillis / (1000 * 60 * 60));
		return hoursElapsed === 1 ? '1 hour' : `${hoursElapsed} hours`;
	}

	const yearDiff = currentDate.getFullYear() - parsedDate.getFullYear();
	const monthDiff = currentDate.getMonth() - parsedDate.getMonth();
	const dayDiff = currentDate.getDate() - parsedDate.getDate();

	let totalMonths = yearDiff * 12 + monthDiff;
	if (dayDiff < 0) {
		totalMonths--; // Adjusts for incomplete months
	}

	if (totalMonths >= 12) {
		const years = Math.floor(totalMonths / 12);
		return years === 1 ? '1 year' : `${years} years`;
	} else if (totalMonths >= 1) {
		return totalMonths === 1 ? '1 month' : `${totalMonths} months`;
	} else {
		const daysElapsed = Math.floor(differenceInMillis / (1000 * 60 * 60 * 24));
		return daysElapsed === 1 ? '1 day' : `${daysElapsed} days`;
	}
}

export function getElapsedTimeText(hovering: boolean, list: List) {
	let elapsedCreateTime = '';
	let elapsedUpdateTime = '';

	try {
		if (list.updatedAt && !elapsedUpdateTime) {
			const updatedAt = formatElapsedTime(list.updatedAt);
			elapsedUpdateTime = updatedAt;
		}

		if (list.createdAt && !elapsedCreateTime) {
			const createdAt = formatElapsedTime(list.createdAt);
			elapsedCreateTime = createdAt;
		}
	} catch (error) {
		if (error instanceof Error) {
			toast.error('Something went wrong while calculating elapsed time!');
		}
	}

	if (hovering && elapsedUpdateTime) {
		return `Published ${elapsedCreateTime} ago`;
	}

	if (elapsedUpdateTime) {
		return `Updated ${elapsedUpdateTime} ago`;
	}

	if (!elapsedUpdateTime) {
		return `Published ${elapsedCreateTime} ago`;
	}
}

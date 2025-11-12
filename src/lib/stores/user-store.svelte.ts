export interface User {
	email?: string;
	name?: string;
	username: string | null | undefined;
	isLoggedIn: boolean;
}

const guestUser: User = {
	email: '',
	name: 'Guest',
	username: 'guest',
	isLoggedIn: false
};

type UserStoreStatus = 'empty' | 'ready';

class UserStore {
	user = $state<User | null>(null);
	status = $state<UserStoreStatus>('empty');

	get name() {
		return this.user?.name ?? 'Guest';
	}

	get email() {
		return this.user?.email;
	}

	get username() {
		return this.user?.username;
	}

	get isLoggedIn() {
		return this.user?.isLoggedIn;
	}

	get isHydrated() {
		return this.status === 'ready';
	}

	setUser(user: User | null) {
		this.user = user;
		this.status = 'ready';
	}

	setGuestUser() {
		this.user = { ...guestUser };
		this.status = 'ready';
	}

	clearUser() {
		this.user = null;
		this.status = 'empty';
	}
}

export const userStore = new UserStore();

export interface User {
	email?: string;
	name?: string;
	username?: string;
	isLoggedIn: boolean;
}

class UserStore {
	user = $state<User | null>(null);

	get name() {
		return this.user?.name;
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

	setUser(user: User | null) {
		this.user = user;
	}

	clearUser() {
		this.user = null;
	}
}

export const userStore = new UserStore();

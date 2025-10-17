export interface User {
	email: string;
	name: string;
	username: string;
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

	setUser(user: User | null) {
		this.user = user;
	}

	clearUser() {
		this.user = null;
	}
}

export const userStore = new UserStore();
